const {
  ORDER_TYPES,
  ROLE_SLUGS,
  SALES_ORDER_STATUSES,
  TASK_CATEGORIES,
  TASK_OPEN_STATUSES,
  TASK_STATUSES,
} = require('../../config/constants');
const { nextTaskNumber } = require('../../utils/counter');
const { itemVisibleAtStage, routeStages, stageTarget, stageUnit } = require('../production/production.flow');
const taskRepo = require('./task.repo');

const STAGE_ROLES = {
  rolling: ROLE_SLUGS.ROLLING_OPERATOR,
  printing: ROLE_SLUGS.PRINTING_OPERATOR,
  cutting: ROLE_SLUGS.CUTTING_OPERATOR,
};

const STAGE_LABELS = { rolling: 'Rolling', printing: 'Printing', cutting: 'Cutting' };

// Created once per order and closed by a person, never by an order status change.
const STICKY_CATEGORIES = [TASK_CATEGORIES.MATERIAL_RECEIVE, TASK_CATEGORIES.PAYMENT_COLLECT];

// Undone (not completed) when an order is sent back to draft.
const UNDONE_ON_RETURN = [TASK_CATEGORIES.ORDER_APPROVE, TASK_CATEGORIES.PRODUCTION_PLAN, TASK_CATEGORIES.MATERIAL_RECEIVE];

const FLOOR_STATUSES = [
  SALES_ORDER_STATUSES.PRODUCTION_PLANNED,
  SALES_ORDER_STATUSES.IN_PRODUCTION,
  SALES_ORDER_STATUSES.READY_FOR_PACKING,
  SALES_ORDER_STATUSES.PACKED,
  SALES_ORDER_STATUSES.READY_FOR_DISPATCH,
  SALES_ORDER_STATUSES.DISPATCHED,
];

const DAY = 24 * 60 * 60 * 1000;

function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 0);
  return d;
}

function daysFromNow(days) {
  return endOfDay(Date.now() + days * DAY);
}

function beforeDelivery(order, days, fallbackDays) {
  if (!order.deliveryDate) return daysFromNow(fallbackDays);
  const due = endOfDay(new Date(order.deliveryDate).getTime() - days * DAY);
  const today = endOfDay(Date.now());
  return due < today ? today : due;
}

function idOf(value) {
  if (!value) return null;
  return value._id || value;
}

function actorName(actor) {
  return actor ? actor.fullName || actor.username || '' : '';
}

function isJobWork(order) {
  return order.orderType === ORDER_TYPES.JOB_WORK;
}

function needsPayment(order) {
  return Number(order.remainingAmount) > 0.005;
}

// One task per item per station that currently shows the item in its floor queue, so lots worked in parallel each get a task.
// A job work's first station waits until the customer's material is in inventory.
function stageSpecs(order, materialIn) {
  const specs = [];
  (order.items || []).forEach((item, index) => {
    const stages = routeStages(item.productionRoute);
    const product = item.product || item.productCode || '';
    stages.forEach((stage, position) => {
      if (!STAGE_ROLES[stage] || !itemVisibleAtStage(item, stage, order.status)) return;
      if (position === 0 && isJobWork(order) && !materialIn && !(item.stageWork || []).length) return;
      specs.push({
        key: `${order._id}:${TASK_CATEGORIES.STAGE_WORK}:${item._id}:${stage}`,
        category: TASK_CATEGORIES.STAGE_WORK,
        title: `${STAGE_LABELS[stage]} - item ${index + 1}${product ? ` (${product})` : ''} - ${order.number}`,
        assigneeRole: STAGE_ROLES[stage],
        itemId: String(item._id),
        itemIndex: index,
        itemLabel: product,
        quantity: stageTarget(item, stage) || null,
        unit: stageUnit(item, stage),
        stage,
        dueDate: beforeDelivery(order, stages.length - 1 - position, 2),
        item,
      });
    });
  });
  return specs;
}

function anyReadyToDispatch(order) {
  return (order.items || []).some((item) => itemVisibleAtStage(item, 'dispatch', order.status));
}

function desiredTasks(order, openTasks, options) {
  const id = String(order._id);
  const number = order.number;
  const kind = isJobWork(order) ? 'job work' : 'order';
  const urgent = order.priority === 'urgent';
  const specs = [];
  const add = (category, extra) => specs.push({ key: `${id}:${category}`, category, ...extra });

  switch (order.status) {
    case SALES_ORDER_STATUSES.DRAFT: {
      const creator = idOf(order.createdBy);
      const owner = creator
        ? { assignee: creator, assigneeName: order.createdBy?.fullName || '' }
        : { assigneeRole: ROLE_SLUGS.SALES_MANAGER };
      const revising = options.returned || openTasks.some((task) => task.category === TASK_CATEGORIES.ORDER_REVISE);
      if (revising) {
        add(TASK_CATEGORIES.ORDER_REVISE, {
          title: `Revise ${number}`,
          description: options.reason ? `Sent back: ${options.reason}` : 'This order was sent back to draft. Fix it and submit again.',
          dueDate: daysFromNow(1),
          ...owner,
        });
      } else {
        add(TASK_CATEGORIES.ORDER_SUBMIT, {
          title: `Complete and submit ${number}`,
          description: `Finish the ${kind} details and submit it for approval.`,
          dueDate: daysFromNow(1),
          ...owner,
        });
      }
      break;
    }
    case SALES_ORDER_STATUSES.SUBMITTED:
      add(TASK_CATEGORIES.ORDER_APPROVE, {
        title: `Approve ${number}`,
        description: `Review the ${kind} and approve it, or send it back to draft with a reason.`,
        assigneeRole: ROLE_SLUGS.SUPER_ADMIN,
        dueDate: daysFromNow(urgent ? 0 : 1),
      });
      break;
    case SALES_ORDER_STATUSES.APPROVED:
      add(TASK_CATEGORIES.PRODUCTION_PLAN, {
        title: `Plan production for ${number}`,
        description: 'Move the approved order to production.',
        assigneeRole: ROLE_SLUGS.PRODUCTION_MANAGER,
        dueDate: daysFromNow(1),
      });
      if (isJobWork(order) && !options.materialIn) {
        add(TASK_CATEGORIES.MATERIAL_RECEIVE, {
          title: `Receive customer material for ${number}`,
          description: 'Record the material supplied by the customer in inventory, linked to this job work.',
          assigneeRole: ROLE_SLUGS.INVENTORY_MANAGER,
          dueDate: daysFromNow(1),
          once: true,
        });
      }
      break;
    case SALES_ORDER_STATUSES.DELIVERED:
    case SALES_ORDER_STATUSES.COMPLETED:
      if (order.status === SALES_ORDER_STATUSES.DELIVERED) {
        add(TASK_CATEGORIES.ORDER_COMPLETE, {
          title: `Mark ${number} completed`,
          description: 'All goods are delivered. Check the order and mark it completed.',
          assigneeRole: ROLE_SLUGS.PRODUCTION_MANAGER,
          dueDate: daysFromNow(2),
        });
      }
      if (needsPayment(order)) {
        add(TASK_CATEGORIES.PAYMENT_COLLECT, {
          title: isJobWork(order) ? `Collect job work charges for ${number}` : `Collect payment for ${number}`,
          description: [
            `Payment terms: ${order.paymentTerms || '-'}`,
            order.creditDays ? `Credit days: ${order.creditDays}` : '',
            order.paymentRemarks || '',
            'Record each payment on the order; this task closes when the balance is paid',
          ]
            .filter(Boolean)
            .join('. '),
          assigneeRole: ROLE_SLUGS.ACCOUNTS,
          dueDate: daysFromNow(Number(order.creditDays) || 7),
          // A written-off (cancelled) payment task is not reopened; a done one is, if a payment is later removed.
          skipIf: { status: TASK_STATUSES.CANCELLED },
        });
      }
      break;
    default:
      break;
  }

  if (FLOOR_STATUSES.includes(order.status)) {
    specs.push(...stageSpecs(order, options.materialIn));
    if (order.status === SALES_ORDER_STATUSES.READY_FOR_DISPATCH) {
      add(TASK_CATEGORIES.DISPATCH, {
        title: `Dispatch ${number}`,
        description: 'All items are ready. Send the goods from the Dispatch register.',
        assigneeRole: ROLE_SLUGS.DISPATCH_MANAGER,
        dueDate: beforeDelivery(order, 1, 1),
      });
    } else if (order.status !== SALES_ORDER_STATUSES.DISPATCHED && anyReadyToDispatch(order)) {
      add(TASK_CATEGORIES.DISPATCH, {
        title: `Dispatch ready items of ${number}`,
        description: 'Some items are ready while others are still in production. Send the ready goods from the Dispatch register.',
        assigneeRole: ROLE_SLUGS.DISPATCH_MANAGER,
        dueDate: beforeDelivery(order, 1, 1),
      });
    }
    if (order.status === SALES_ORDER_STATUSES.DISPATCHED) {
      add(TASK_CATEGORIES.DELIVERY_CONFIRM, {
        title: `Finish dispatch and confirm delivery of ${number}`,
        description: 'Part of the order has gone out. Send the rest and confirm delivery.',
        assigneeRole: ROLE_SLUGS.DISPATCH_MANAGER,
        dueDate: beforeDelivery(order, 0, 1),
      });
    }
  }

  return specs;
}

function pushHistory(task, to, actor, note) {
  task.history.push({
    from: task.status,
    to,
    by: actor?._id || null,
    byName: actorName(actor) || 'System',
    note,
  });
}

function closeTask(task, status, actor, note) {
  pushHistory(task, status, actor, note);
  task.status = status;
  task.openKey = undefined;
  task.completedAt = new Date();
  if (status === TASK_STATUSES.DONE) {
    task.completedBy = actor?._id || null;
    task.completedByName = actorName(actor);
  }
}

function claimFromFloor(task, item, actor) {
  if (task.category !== TASK_CATEGORIES.STAGE_WORK || !item) return false;
  const pickup = item.stagePickup;
  const lastRow = [...(item.stageWork || [])].reverse().find((row) => row.stage === task.stage);
  const worker =
    pickup?.stage === task.stage && pickup.pickedBy
      ? { id: pickup.pickedBy, name: pickup.pickedByName }
      : lastRow?.operator
        ? { id: lastRow.operator, name: lastRow.operatorName }
        : null;
  if (!worker) return false;

  let changed = false;
  if (!task.assignee) {
    task.assignee = worker.id;
    task.assigneeName = worker.name || '';
    changed = true;
  }
  if (task.status === TASK_STATUSES.OPEN || task.status === TASK_STATUSES.BLOCKED) {
    pushHistory(task, TASK_STATUSES.IN_PROGRESS, actor, 'Work started on the floor');
    task.status = TASK_STATUSES.IN_PROGRESS;
    task.blockedReason = '';
    task.startedAt = task.startedAt || new Date();
    changed = true;
  }
  return changed;
}

// Undoing "start work" before any entry hands the station task back to the team queue.
function releaseToQueue(task, item, released, actor) {
  if (!released || task.category !== TASK_CATEGORIES.STAGE_WORK || !item) return false;
  if (task.itemId !== String(released.itemId) || task.stage !== released.stage) return false;
  if (task.status !== TASK_STATUSES.IN_PROGRESS) return false;
  if (released.by && String(idOf(task.assignee)) !== String(released.by)) return false;
  if ((item.stageWork || []).some((row) => row.stage === task.stage)) return false;
  pushHistory(task, TASK_STATUSES.OPEN, actor, 'Work released on the floor, back in the station queue');
  task.status = TASK_STATUSES.OPEN;
  task.assignee = null;
  task.assigneeName = '';
  task.startedAt = null;
  return true;
}

async function createTask(spec, order) {
  try {
    const task = await taskRepo.create({
      number: await nextTaskNumber(),
      title: spec.title,
      description: spec.description || '',
      category: spec.category,
      source: 'auto',
      autoKey: spec.key,
      openKey: spec.key,
      order: order._id,
      orderNumber: order.number,
      orderType: order.orderType || '',
      itemId: spec.itemId || '',
      itemIndex: spec.itemIndex ?? null,
      itemLabel: spec.itemLabel || '',
      quantity: spec.quantity ?? null,
      unit: spec.unit || '',
      stage: spec.stage || '',
      assignee: spec.assignee || null,
      assigneeName: spec.assigneeName || '',
      assigneeRole: spec.assigneeRole || '',
      priority: order.priority || 'normal',
      dueDate: spec.dueDate || null,
      history: [{ from: '', to: TASK_STATUSES.OPEN, byName: 'System', note: 'Created automatically' }],
    });
    if (claimFromFloor(task, spec.item, null)) await taskRepo.save(task);
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
}

async function cancelAll(order, actor, reason) {
  const open = await taskRepo.find({ order: order._id, status: { $in: TASK_OPEN_STATUSES } });
  for (const task of open) {
    closeTask(task, TASK_STATUSES.CANCELLED, actor, reason ? `Order cancelled: ${reason}` : 'Order cancelled');
    await taskRepo.save(task);
  }
}

// Manual tasks can point at a line item; keep that link true when a draft is edited.
async function refreshManualItemLinks(order, actor) {
  const linked = await taskRepo.find({
    order: order._id,
    source: 'manual',
    itemId: { $ne: '' },
    status: { $in: TASK_OPEN_STATUSES },
  });
  for (const task of linked) {
    const index = (order.items || []).findIndex((item) => String(item._id) === task.itemId);
    const item = index >= 0 ? order.items[index] : null;
    const notes = [];
    if (!item) {
      notes.push(`Item "${task.itemLabel || 'line item'}" was removed from the order`);
      task.itemId = '';
      task.itemIndex = null;
      task.quantity = null;
      task.unit = '';
    } else {
      const label = item.product || item.productCode || '';
      if (task.itemIndex !== index) task.itemIndex = index;
      if (task.itemLabel !== label) task.itemLabel = label;
      if (task.unit !== (item.unit || '')) task.unit = item.unit || '';
      const max = Number(item.quantity) || 0;
      if (task.quantity != null && max > 0 && task.quantity > max) {
        notes.push(`Quantity lowered from ${task.quantity} to ${max} ${item.unit || ''} to match the order`.trim());
        task.quantity = max;
      }
    }
    if (!notes.length && !task.isModified()) continue;
    for (const note of notes) {
      task.history.push({ from: task.status, to: task.status, by: actor?._id || null, byName: actorName(actor) || 'System', note });
    }
    await taskRepo.save(task);
  }
}

async function reconcile(order, actor, options) {
  if (order.status === SALES_ORDER_STATUSES.CANCELLED) {
    await cancelAll(order, actor, options.reason);
    return;
  }
  await refreshManualItemLinks(order, actor);

  const materialIn =
    isJobWork(order) &&
    Boolean(await require('../inventory/item.model').exists({ salesOrder: order._id, kind: { $ne: 'wip' } }));
  const open = await taskRepo.find({ order: order._id, source: 'auto', status: { $in: TASK_OPEN_STATUSES } });
  const wanted = desiredTasks(order, open, { ...options, materialIn });
  const wantedKeys = new Set(wanted.map((spec) => spec.key));
  const backToDraft = order.status === SALES_ORDER_STATUSES.DRAFT;

  for (const task of open) {
    if (wantedKeys.has(task.autoKey)) continue;
    const satisfied =
      task.category === TASK_CATEGORIES.MATERIAL_RECEIVE && materialIn
        ? 'Closed automatically: customer material recorded in inventory'
        : task.category === TASK_CATEGORIES.PAYMENT_COLLECT && !needsPayment(order)
          ? 'Closed automatically: balance fully paid'
          : '';
    if (satisfied) {
      closeTask(task, TASK_STATUSES.DONE, actor, satisfied);
      await taskRepo.save(task);
      continue;
    }
    if (STICKY_CATEGORIES.includes(task.category) && !(backToDraft && UNDONE_ON_RETURN.includes(task.category))) continue;
    const undone =
      (backToDraft && UNDONE_ON_RETURN.includes(task.category)) ||
      (task.category === TASK_CATEGORIES.ORDER_COMPLETE && order.status !== SALES_ORDER_STATUSES.COMPLETED);
    const stageFinished = task.category === TASK_CATEGORIES.STAGE_WORK && FLOOR_STATUSES.includes(order.status);
    closeTask(
      task,
      undone ? TASK_STATUSES.CANCELLED : TASK_STATUSES.DONE,
      actor,
      undone
        ? backToDraft
          ? 'Order sent back to draft'
          : `Order went back to ${String(order.status).replace(/_/g, ' ')}`
        : stageFinished
          ? 'Closed automatically: work at this station is finished'
          : `Closed automatically: order is now ${String(order.status).replace(/_/g, ' ')}`
    );
    await taskRepo.save(task);
  }

  for (const spec of wanted) {
    const existing = open.find((task) => task.autoKey === spec.key);
    if (existing) {
      let changed = false;
      for (const field of ['title', 'itemLabel', 'itemIndex', 'quantity', 'unit']) {
        if (spec[field] !== undefined && existing[field] !== spec[field]) {
          existing[field] = spec[field];
          changed = true;
        }
      }
      if (existing.priority !== (order.priority || 'normal')) {
        existing.priority = order.priority || 'normal';
        changed = true;
      }
      if (releaseToQueue(existing, spec.item, options.released, actor)) changed = true;
      if (claimFromFloor(existing, spec.item, actor)) changed = true;
      if (changed) await taskRepo.save(existing);
      continue;
    }
    if (spec.once && (await taskRepo.exists({ autoKey: spec.key, status: { $ne: TASK_STATUSES.CANCELLED } }))) continue;
    if (spec.skipIf && (await taskRepo.exists({ autoKey: spec.key, ...spec.skipIf }))) continue;
    await createTask(spec, order);
  }
}

// Never throws: a task failure must not block the order action that triggered it.
async function syncOrder(order, actor = null, options = {}) {
  if (!order?._id) return;
  try {
    await reconcile(order, actor, options);
  } catch (error) {
    console.error(`Task sync failed for ${order.number || order._id}`, error.message);
  }
}

async function removeForOrder(orderId) {
  try {
    await taskRepo.deleteByOrder(orderId);
  } catch (error) {
    console.error('Removing tasks for deleted order failed', error.message);
  }
}

async function backfillOpenOrders() {
  const salesOrderRepo = require('../salesOrder/salesOrder.repo');
  const orders = await salesOrderRepo.findAll({
    status: { $nin: [SALES_ORDER_STATUSES.COMPLETED, SALES_ORDER_STATUSES.CANCELLED] },
  });
  for (const order of orders) {
    await syncOrder(order, null);
  }
  return orders.length;
}

module.exports = {
  STICKY_CATEGORIES,
  syncOrder,
  removeForOrder,
  backfillOpenOrders,
};
