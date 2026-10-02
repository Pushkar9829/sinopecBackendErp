const mongoose = require('mongoose');
const audit = require('../modules/audit/audit.service');
const { COOKIES } = require('../config/constants');
const { verifyAccessToken } = require('../utils/tokens');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SKIPPED = new Set(['/api/auth/refresh']);

const MODULE_LABELS = {
  auth: 'Login',
  users: 'Users',
  roles: 'Roles',
  permissions: 'Permissions',
  inventory: 'Inventory',
  machines: 'Machines',
  customers: 'Customers',
  'sales-orders': 'Orders',
  'sales-settings': 'Product setup',
  production: 'Production',
  registers: 'Registers',
  media: 'Files',
  tasks: 'Tasks',
};

const MODELS = {
  'users/': ['User', 'User'],
  'roles/': ['Role', 'Role'],
  'inventory/stages': ['InventoryStage', 'Stage'],
  'inventory/items': ['InventoryItem', 'Inventory item'],
  'machines/': ['Machine', 'Machine'],
  'customers/': ['Customer', 'Customer'],
  'sales-orders/': ['SalesOrder', 'Order'],
  'tasks/': ['Task', 'Task'],
  'sales-settings/options': ['SalesOption', 'List word'],
  'sales-settings/templates': ['ProductTemplate', 'Saved product'],
};

const COLLECTION_MODULES = new Set(['inventory', 'sales-settings']);

const PRODUCTION_ACTIONS = {
  pickup: 'took material',
  release: 'returned material to store',
  enter: 'made a register entry',
  'entry update': 'edited a register entry',
  'entry delete': 'deleted a register entry',
  complete: 'completed stage work',
};

const isId = (value) => /^[a-f0-9]{24}$/i.test(value);

function modelByName(name) {
  try {
    return mongoose.model(name);
  } catch {
    return null;
  }
}

function resolveTarget(req) {
  const path = req.originalUrl.split('?')[0];
  const segments = path.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const module = segments[0] || '';
  const rest = segments.slice(1);
  const id = rest.find(isId) || '';
  const words = rest.filter((part) => !isId(part));
  const collection = COLLECTION_MODULES.has(module) ? words.shift() || '' : '';
  const [modelName, entityType] = MODELS[`${module}/${collection}`] || [];

  let action;
  if (module === 'production') {
    action = PRODUCTION_ACTIONS[words.join(' ')] || words.join(' ');
  } else if (module === 'auth') {
    action = { login: 'logged in', logout: 'logged out' }[words.join(' ')] || words.join(' ') || 'auth';
  } else if (words.length) {
    const tail = words.join(' ').replace(/-/g, ' ');
    if (tail === 'attachments') action = req.method === 'DELETE' ? 'removed attachment' : 'added attachment';
    else if (tail === 'payments') action = req.method === 'DELETE' ? 'removed payment' : 'recorded payment';
    else if (tail === 'permissions') action = 'updated permissions';
    else action = tail;
  } else if (req.method === 'POST') action = module === 'media' ? 'uploaded file' : 'created';
  else if (req.method === 'DELETE') action = 'deleted';
  else action = 'updated';

  return {
    path,
    module,
    moduleLabel: MODULE_LABELS[module] || module,
    id,
    action,
    entityType: entityType || (module === 'production' ? 'Order' : MODULE_LABELS[module] || module),
    model: modelName ? modelByName(modelName) : null,
  };
}

function labelOf(doc) {
  if (!doc) return '';
  return String(doc.number || doc.orderNumber || doc.name || doc.fullName || doc.username || doc.value || doc.code || '');
}

async function actorFor(req, responseBody, target) {
  if (req.user) return req.user;
  if (target.module === 'auth' && target.action === 'logged in' && responseBody?.data?.id) {
    return { _id: responseBody.data.id, fullName: responseBody.data.fullName, username: responseBody.data.username, role: responseBody.data.role };
  }
  const header = req.headers.authorization || '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : req.cookies?.[COOKIES.ACCESS];
  if (!token) return null;
  try {
    const payload = verifyAccessToken(token);
    const User = modelByName('User');
    return User ? await User.findById(payload.sub).populate('role').lean() : null;
  } catch {
    return null;
  }
}

async function writeLog(req, res, target, before, responseBody) {
  const success = res.statusCode < 400;
  const actor = await actorFor(req, responseBody, target);
  const responseData = responseBody?.data;

  let entityId = target.id || (responseData && typeof responseData === 'object' && responseData.id ? String(responseData.id) : '');
  let after = null;
  if (target.model && entityId && success && req.method !== 'DELETE') {
    after = await target.model.findById(entityId).lean().catch(() => null);
  }

  let entityLabel = labelOf(after) || labelOf(before) || labelOf(responseData);
  if (target.module === 'production' && req.body?.orderId) {
    entityId = String(req.body.orderId);
    const order = await modelByName('SalesOrder')?.findById(req.body.orderId).select('number').lean().catch(() => null);
    entityLabel = order?.number || '';
  }
  if (target.module === 'auth') entityLabel = String(req.body?.username || actor?.username || '');
  if (target.module === 'media' && req.file) entityLabel = req.file.originalname || '';

  const actorName = actor?.fullName || actor?.username || (target.module === 'auth' ? String(req.body?.username || '') : '');
  const stageNote = target.module === 'production' && req.body?.stage ? ` (${req.body.stage})` : '';
  const isAuth = target.module === 'auth';
  const failedText = isAuth ? `failed to ${target.action === 'logged in' ? 'log in' : target.action}` : `tried: ${target.action}`;
  const summary = [
    actorName || 'Someone',
    success ? target.action : failedText,
    isAuth ? '' : target.entityType.toLowerCase(),
    isAuth && entityLabel === actorName ? '' : entityLabel,
  ]
    .filter(Boolean)
    .join(' ')
    .concat(stageNote);

  const changes = success && target.model && (before || after) ? audit.diff(before, after) : [];
  const payload = audit.sanitize({
    body: req.body && Object.keys(req.body).length ? req.body : undefined,
    file: req.file ? { name: req.file.originalname, size: req.file.size, type: req.file.mimetype } : undefined,
    files: Array.isArray(req.files) ? req.files.map((file) => ({ name: file.originalname, size: file.size })) : undefined,
  });

  await audit.record({
    actor: actor?._id || null,
    actorName,
    actorRole: actor?.role?.name || '',
    method: req.method,
    path: target.path,
    module: target.moduleLabel,
    action: target.action,
    entityType: target.entityType,
    entityId,
    entityLabel,
    summary,
    status: res.statusCode,
    success,
    error: success ? '' : String(responseBody?.message || '').slice(0, 500),
    ip: req.ip || '',
    userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    changes,
    payload,
  });
}

function auditTrail(req, res, next) {
  const path = req.originalUrl.split('?')[0];
  if (!MUTATING.has(req.method) || SKIPPED.has(path)) return next();

  const target = resolveTarget(req);
  let responseBody;
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    responseBody = body;
    return sendJson(body);
  };

  const loadBefore = target.model && target.id ? target.model.findById(target.id).lean().catch(() => null) : Promise.resolve(null);
  loadBefore.then((before) => {
    res.on('finish', () => {
      writeLog(req, res, target, before, responseBody).catch((error) => console.error('Audit log failed', error.message));
    });
    next();
  });
}

module.exports = auditTrail;
