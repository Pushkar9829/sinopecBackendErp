const mongoose = require('mongoose');
const {
  ORDER_PRIORITIES,
  ROLE_SLUGS,
  TASK_CATEGORIES,
  TASK_OPEN_STATUSES,
  TASK_STATUSES,
} = require('../../config/constants');
const ApiError = require('../../utils/ApiError');
const { nextTaskNumber } = require('../../utils/counter');
const { hasPermission } = require('../../utils/permissions');
const { operatorStations } = require('../production/production.flow');
const User = require('../user/user.model');
const SalesOrder = require('../salesOrder/salesOrder.model');
const taskRepo = require('./task.repo');
const { STICKY_CATEGORIES } = require('./task.hooks');

const STATION_ROLES = [
  ROLE_SLUGS.ROLLING_OPERATOR,
  ROLE_SLUGS.PRINTING_OPERATOR,
  ROLE_SLUGS.CUTTING_OPERATOR,
  ROLE_SLUGS.PACKING_OPERATOR,
];

const ROLE_SLUG_LIST = Object.values(ROLE_SLUGS);

// Work a team shares and one person picks up; order-level steps are just done from the order page.
const CLAIMABLE_CATEGORIES = [
  TASK_CATEGORIES.STAGE_WORK,
  TASK_CATEGORIES.DISPATCH,
  TASK_CATEGORIES.DELIVERY_CONFIRM,
  TASK_CATEGORIES.MATERIAL_RECEIVE,
  TASK_CATEGORIES.PAYMENT_COLLECT,
  TASK_CATEGORIES.CUSTOM,
];

function str(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function roleOf(user) {
  return user?.role?.slug || '';
}

function nameOf(user) {
  return user?.fullName || user?.username || '';
}

function sameId(a, b) {
  return Boolean(a && b) && String(a._id || a) === String(b._id || b);
}

function isTaskAdmin(user) {
  return hasPermission(user, 'tasks:*');
}

function teamRoles(user) {
  const role = roleOf(user);
  if (!role) return [];
  if (role === ROLE_SLUGS.PRODUCTION_MANAGER) return [role, ...STATION_ROLES];
  return [role];
}

function canSee(user, task) {
  return (
    isTaskAdmin(user) ||
    sameId(task.assignee, user._id) ||
    sameId(task.createdBy, user._id) ||
    teamRoles(user).includes(task.assigneeRole)
  );
}

function canManage(user, task) {
  return (
    isTaskAdmin(user) ||
    (task.source === 'manual' && sameId(task.createdBy, user._id)) ||
    (roleOf(user) === ROLE_SLUGS.PRODUCTION_MANAGER && STATION_ROLES.includes(task.assigneeRole))
  );
}

function canWork(user, task) {
  return canManage(user, task) || sameId(task.assignee, user._id) || (task.assigneeRole && task.assigneeRole === roleOf(user));
}

function closesItself(task) {
  return task.source === 'auto' && !STICKY_CATEGORIES.includes(task.category);
}

function isOpen(task) {
  return TASK_OPEN_STATUSES.includes(task.status);
}

function present(task, user) {
  const data = task.toJSON();
  data.overdue = isOpen(task) && Boolean(task.dueDate) && new Date(task.dueDate).getTime() < Date.now();
  data.closesItself = closesItself(task);
  data.canWork = canWork(user, task);
  data.canManage = canManage(user, task);
  data.canClaim =
    isOpen(task) &&
    CLAIMABLE_CATEGORIES.includes(task.category) &&
    !task.assignee &&
    Boolean(task.assigneeRole) &&
    (teamRoles(user).includes(task.assigneeRole) || isTaskAdmin(user));
  return data;
}

const DISPATCH_CATEGORIES = [TASK_CATEGORIES.DISPATCH, TASK_CATEGORIES.DELIVERY_CONFIRM];

async function presentAll(tasks, user) {
  const stageTasks = tasks.filter((task) => task.category === TASK_CATEGORIES.STAGE_WORK && task.order && task.itemId && task.stage);
  const dispatchTasks = tasks.filter((task) => DISPATCH_CATEGORIES.includes(task.category) && task.order);
  const orderIds = [...new Set([...stageTasks, ...dispatchTasks].map((task) => String(task.order?._id || task.order)))];
  const orders = orderIds.length
    ? await SalesOrder.find({ _id: { $in: orderIds } }).select(
        'items customerSnapshot deliveryDate deliveryLocation shippingAddress deliveryInstructions productionInstructions'
      )
    : [];
  const byOrder = new Map(orders.map((order) => [String(order._id), order]));
  const { stageStats } = require('../production/production.flow');
  const { stageJob, dispatchJob } = require('./task.jobsheet');
  return tasks.map((task) => {
    const data = present(task, user);
    const order = byOrder.get(String(task.order?._id || task.order));
    if (order && dispatchTasks.includes(task)) data.job = dispatchJob(order);
    if (!stageTasks.includes(task)) return data;
    const item = order?.items.id(task.itemId);
    if (!item) return data;
    data.job = stageJob(order, item, task.stage);
    const stats = stageStats(item, task.stage);
    data.progress = {
      output: Math.round(stats.output * 1000) / 1000,
      target: Math.round(stats.target * 1000) / 1000,
      remaining: Math.round(stats.remaining * 1000) / 1000,
      unit: stats.unit,
      done: stats.done,
    };
    return data;
  });
}

function inboxFilter(user) {
  const or = [{ assignee: user._id }];
  if (roleOf(user)) or.push({ assigneeRole: roleOf(user), assignee: null });
  return { $or: or };
}

function scopeFilter(user, scope) {
  switch (scope) {
    case 'mine':
      return { assignee: user._id };
    case 'role':
      return { assigneeRole: { $in: teamRoles(user) } };
    case 'created':
      return { createdBy: user._id };
    case 'all':
      if (isTaskAdmin(user)) return {};
      return { $or: [{ assignee: user._id }, { createdBy: user._id }, { assigneeRole: { $in: teamRoles(user) } }] };
    case 'inbox':
    default:
      return inboxFilter(user);
  }
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function listTasks(user, query = {}) {
  const filter = { ...scopeFilter(user, str(query.scope)) };

  const status = str(query.status);
  if (!status || status === 'active') filter.status = { $in: TASK_OPEN_STATUSES };
  else if (status !== 'any') {
    const wanted = status.split(',').filter((value) => Object.values(TASK_STATUSES).includes(value));
    if (wanted.length) filter.status = { $in: wanted };
  }
  if (str(query.category) && Object.values(TASK_CATEGORIES).includes(str(query.category))) filter.category = str(query.category);
  if (['sales_order', 'job_work'].includes(str(query.orderType))) filter.orderType = str(query.orderType);
  if (str(query.overdue) === '1' || str(query.overdue) === 'true') {
    filter.dueDate = { $lt: new Date() };
    filter.status = { $in: TASK_OPEN_STATUSES };
  }
  const q = str(query.q);
  if (q) {
    const regex = new RegExp(escapeRegex(q), 'i');
    filter.$and = [{ $or: [{ title: regex }, { orderNumber: regex }, { number: regex }, { assigneeName: regex }] }];
  }

  const tasks = await taskRepo.find(filter);
  return presentAll(tasks, user);
}

async function getSummary(user) {
  const open = { status: { $in: TASK_OPEN_STATUSES } };
  const now = new Date();
  const role = roleOf(user);
  const [assigned, roleQueue, overdue, top] = await Promise.all([
    taskRepo.count({ ...open, assignee: user._id }),
    role ? taskRepo.count({ ...open, assigneeRole: role, assignee: null }) : 0,
    taskRepo.count({ ...open, ...inboxFilter(user), dueDate: { $lt: now } }),
    taskRepo.find({ ...open, ...inboxFilter(user) }, { limit: 5 }),
  ]);
  return {
    assigned,
    roleQueue,
    overdue,
    total: assigned + roleQueue,
    top: top.map((task) => present(task, user)),
  };
}

async function loadTask(id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Invalid task id');
  const task = await taskRepo.findById(id);
  if (!task) throw new ApiError(404, 'Task not found');
  return task;
}

async function loadVisibleTask(user, id) {
  const task = await loadTask(id);
  if (!canSee(user, task)) throw new ApiError(404, 'Task not found');
  return task;
}

async function getTask(user, id) {
  const [task] = await presentAll([await loadVisibleTask(user, id)], user);
  return task;
}

async function listForOrder(user, orderId) {
  await require('../salesOrder/salesOrder.service').getOrder(user, orderId);
  const tasks = await taskRepo.findByOrder(orderId);
  return presentAll(tasks.filter((task) => canSee(user, task)), user);
}

async function resolveAssignee(payload) {
  const assigneeId = str(payload.assigneeId);
  if (assigneeId) {
    if (!mongoose.isValidObjectId(assigneeId)) throw new ApiError(400, 'Invalid assignee');
    const assignee = await User.findById(assigneeId).populate('role', 'slug');
    if (!assignee || !assignee.isActive) throw new ApiError(400, 'Assignee not found or inactive');
    return { assignee: assignee._id, assigneeName: nameOf(assignee), assigneeRole: '' };
  }
  const assigneeRole = str(payload.assigneeRole);
  if (assigneeRole) {
    if (!ROLE_SLUG_LIST.includes(assigneeRole)) throw new ApiError(400, 'Invalid role');
    return { assignee: null, assigneeName: '', assigneeRole };
  }
  return null;
}

function parseDue(value) {
  if (value === null || value === '') return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 23, 59, 59);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ApiError(400, 'Due date is not valid');
  return date;
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function resolveItemLink(order, itemId, quantity) {
  const id = str(itemId);
  if (!id) {
    if (hasValue(quantity)) throw new ApiError(400, 'Choose the item the quantity is for');
    return { itemId: '', itemIndex: null, itemLabel: '', quantity: null, unit: '' };
  }
  const index = (order.items || []).findIndex((item) => String(item._id) === id);
  if (index < 0) throw new ApiError(400, `That item is not on ${order.number}`);
  const item = order.items[index];
  const max = Number(item.quantity) || 0;
  let qty = null;
  if (hasValue(quantity)) {
    qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) throw new ApiError(400, 'Quantity must be more than 0');
    if (max > 0 && qty > max) throw new ApiError(400, `Quantity cannot be more than ${max} ${item.unit || ''} ordered`.trim());
  }
  return {
    itemId: id,
    itemIndex: index,
    itemLabel: item.product || item.productCode || '',
    quantity: qty,
    unit: item.unit || '',
  };
}

function pushHistory(task, to, user, note = '') {
  task.history.push({ from: task.status, to, by: user._id, byName: nameOf(user), note });
}

async function createTask(user, payload) {
  const title = str(payload.title);
  if (!title) throw new ApiError(400, 'Title is required');
  const priority = str(payload.priority) || ORDER_PRIORITIES.NORMAL;
  if (!Object.values(ORDER_PRIORITIES).includes(priority)) throw new ApiError(400, 'Priority must be normal, high, or urgent');

  let order = null;
  if (str(payload.orderId)) {
    if (!mongoose.isValidObjectId(payload.orderId)) throw new ApiError(400, 'Invalid order');
    await require('../salesOrder/salesOrder.service').getOrder(user, payload.orderId);
    order = await SalesOrder.findById(payload.orderId).select('number orderType priority status items');
    if (!order) throw new ApiError(404, 'Order not found');
    if (order.status === 'cancelled') throw new ApiError(400, 'This order is cancelled');
  }
  if (!order && (str(payload.itemId) || hasValue(payload.quantity))) {
    throw new ApiError(400, 'Link the task to an order before choosing an item or quantity');
  }
  const itemLink = order ? resolveItemLink(order, payload.itemId, payload.quantity) : {};

  const owner = (await resolveAssignee(payload)) || { assignee: user._id, assigneeName: nameOf(user), assigneeRole: '' };
  const task = await taskRepo.create({
    number: await nextTaskNumber(),
    title,
    description: str(payload.description),
    category: TASK_CATEGORIES.CUSTOM,
    source: 'manual',
    order: order?._id || null,
    orderNumber: order?.number || '',
    orderType: order?.orderType || '',
    ...itemLink,
    ...owner,
    priority,
    dueDate: payload.dueDate ? parseDue(payload.dueDate) : null,
    createdBy: user._id,
    createdByName: nameOf(user),
    history: [{ from: '', to: TASK_STATUSES.OPEN, by: user._id, byName: nameOf(user), note: 'Created' }],
  });
  return present(task, user);
}

function applyStatus(user, task, status, note) {
  if (!Object.values(TASK_STATUSES).includes(status)) throw new ApiError(400, 'Invalid task status');
  if (status === task.status) return;
  if (!canWork(user, task)) throw new ApiError(403, 'You cannot work on this task');

  const closing = status === TASK_STATUSES.DONE || status === TASK_STATUSES.CANCELLED;
  if (closing && closesItself(task)) {
    throw new ApiError(400, 'This task closes automatically when the order moves to the next step');
  }
  if (!isOpen(task)) {
    if (task.source === 'auto') throw new ApiError(400, 'A closed automatic task cannot be reopened');
    if (status !== TASK_STATUSES.OPEN && status !== TASK_STATUSES.IN_PROGRESS) {
      throw new ApiError(400, 'Reopen the task first');
    }
  }
  if (status === TASK_STATUSES.CANCELLED && !canManage(user, task)) {
    throw new ApiError(403, 'Only the task owner or a manager can cancel this task');
  }
  if (status === TASK_STATUSES.BLOCKED && !note) throw new ApiError(400, 'Give a reason for blocking the task');

  pushHistory(task, status, user, note);
  task.status = status;
  task.blockedReason = status === TASK_STATUSES.BLOCKED ? note : '';

  if (status === TASK_STATUSES.IN_PROGRESS) {
    task.startedAt = task.startedAt || new Date();
    if (!task.assignee) {
      task.assignee = user._id;
      task.assigneeName = nameOf(user);
    }
  }
  if (closing) {
    task.completedAt = new Date();
    task.openKey = undefined;
    if (status === TASK_STATUSES.DONE) {
      task.completedBy = user._id;
      task.completedByName = nameOf(user);
    }
  } else {
    task.completedAt = null;
    task.completedBy = null;
    task.completedByName = '';
  }
}

async function updateTask(user, id, payload) {
  const task = await loadVisibleTask(user, id);
  const note = str(payload.note || payload.blockedReason);

  const editsDetails = ['title', 'description', 'dueDate', 'priority', 'assigneeId', 'assigneeRole', 'itemId', 'quantity'].some(
    (key) => payload[key] !== undefined
  );
  if (editsDetails && !canManage(user, task)) throw new ApiError(403, 'Only the task owner or a manager can change this task');

  if (payload.title !== undefined) {
    if (task.source === 'auto') throw new ApiError(400, 'Automatic task titles cannot be changed');
    if (!str(payload.title)) throw new ApiError(400, 'Title cannot be empty');
    task.title = str(payload.title);
  }
  if (payload.itemId !== undefined || payload.quantity !== undefined) {
    if (task.source === 'auto') throw new ApiError(400, 'The item and quantity of an automatic task come from the order');
    if (!task.order) throw new ApiError(400, 'Link the task to an order before choosing an item or quantity');
    const order = await SalesOrder.findById(task.order).select('number items');
    if (!order) throw new ApiError(404, 'Order not found');
    const link = resolveItemLink(
      order,
      payload.itemId !== undefined ? payload.itemId : task.itemId,
      payload.quantity !== undefined ? payload.quantity : task.quantity
    );
    Object.assign(task, link);
  }
  if (payload.description !== undefined) task.description = str(payload.description);
  if (payload.dueDate !== undefined) task.dueDate = parseDue(payload.dueDate);
  if (payload.priority !== undefined && payload.priority !== task.priority) {
    if (!Object.values(ORDER_PRIORITIES).includes(payload.priority)) throw new ApiError(400, 'Invalid priority');
    if (task.source === 'auto') throw new ApiError(400, 'Automatic tasks follow the order priority. Change it on the order.');
    task.priority = payload.priority;
  }
  if (payload.assigneeId !== undefined || payload.assigneeRole !== undefined) {
    const owner = await resolveAssignee(payload);
    if (owner && !owner.assignee && task.source === 'auto' && owner.assigneeRole !== task.assigneeRole) {
      throw new ApiError(400, 'Automatic tasks stay with their team. Assign a person instead.');
    }
    if (owner) {
      const keepRole = owner.assignee && task.source === 'auto' ? task.assigneeRole : owner.assigneeRole;
      Object.assign(task, owner, { assigneeRole: keepRole });
    } else if (payload.assigneeId === null || payload.assigneeId === '') {
      if (!task.assigneeRole) throw new ApiError(400, 'A task must have a person or a role');
      task.assignee = null;
      task.assigneeName = '';
    }
    task.history.push({
      from: task.status,
      to: task.status,
      by: user._id,
      byName: nameOf(user),
      note: `Assigned to ${task.assigneeName || task.assigneeRole.replace(/_/g, ' ')}`,
    });
  }
  if (str(payload.status) === TASK_STATUSES.DONE && task.category === TASK_CATEGORIES.PAYMENT_COLLECT && task.order) {
    const order = await SalesOrder.findById(task.order).select('remainingAmount');
    if (order && Number(order.remainingAmount) > 0.005) {
      throw new ApiError(400, `Record the payment on the order first. ${order.remainingAmount} is still due.`);
    }
  }
  if (payload.status !== undefined) applyStatus(user, task, str(payload.status), note);

  await taskRepo.save(task);
  return presentOne(task, user);
}

async function presentOne(task, user) {
  const [view] = await presentAll([task], user);
  return view;
}

async function assigneeIsActive(task) {
  if (!task.assignee) return false;
  const assignee = await User.findById(task.assignee).select('isActive');
  return Boolean(assignee?.isActive);
}

async function claimTask(user, id) {
  const task = await loadVisibleTask(user, id);
  if (!isOpen(task)) throw new ApiError(400, 'This task is already closed');
  if (!CLAIMABLE_CATEGORIES.includes(task.category)) throw new ApiError(400, 'This task is done from the order page, it cannot be taken');
  if (task.assignee && !sameId(task.assignee, user._id) && !isTaskAdmin(user) && (await assigneeIsActive(task))) {
    throw new ApiError(400, `Already taken by ${task.assigneeName || 'someone else'}`);
  }
  if (!(teamRoles(user).includes(task.assigneeRole) || isTaskAdmin(user) || sameId(task.assignee, user._id))) {
    throw new ApiError(403, 'This task belongs to another role');
  }
  pushHistory(task, TASK_STATUSES.IN_PROGRESS, user, 'Claimed');
  task.assignee = user._id;
  task.assigneeName = nameOf(user);
  task.status = TASK_STATUSES.IN_PROGRESS;
  task.startedAt = task.startedAt || new Date();
  await taskRepo.save(task);
  return presentOne(task, user);
}

async function addComment(user, id, text) {
  const task = await loadVisibleTask(user, id);
  const body = str(text);
  if (!body) throw new ApiError(400, 'Comment cannot be empty');
  if (body.length > 2000) throw new ApiError(400, 'Comment is too long');
  task.comments.push({ by: user._id, byName: nameOf(user), text: body });
  await taskRepo.save(task);
  return presentOne(task, user);
}

async function listAssignees() {
  const users = await User.find({ isActive: true }).populate('role', 'name slug').sort({ fullName: 1 });
  return users.map((user) => ({
    id: String(user._id),
    fullName: nameOf(user),
    username: user.username,
    role: user.role ? { slug: user.role.slug, name: user.role.name } : null,
  }));
}

module.exports = {
  listTasks,
  getSummary,
  getTask,
  listForOrder,
  createTask,
  updateTask,
  claimTask,
  addComment,
  listAssignees,
};
