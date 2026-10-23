const path = require('path');
const cookieParser = require('cookie-parser');
const express = require('express');
const helmet = require('helmet');
const { applyCorsHeaders } = require('./config/cors');
const errorHandler = require('./middlewares/errorHandler');
const authRoutes = require('./modules/auth/auth.routes');
const permissionRoutes = require('./modules/permission/permission.routes');
const roleRoutes = require('./modules/role/role.routes');
const userRoutes = require('./modules/user/user.routes');
const inventoryRoutes = require('./modules/inventory/inventory.routes');
const machineRoutes = require('./modules/machine/machine.routes');
const customerRoutes = require('./modules/customer/customer.routes');
const salesOrderRoutes = require('./modules/salesOrder/salesOrder.routes');
const salesSettingsRoutes = require('./modules/salesSettings/salesSettings.routes');
const productionRoutes = require('./modules/production/production.routes');
const registerRoutes = require('./modules/register/register.routes');
const analyticsRoutes = require('./modules/analytics/analytics.routes');
const mediaRoutes = require('./modules/media/media.routes');
const auditRoutes = require('./modules/audit/audit.routes');
const taskRoutes = require('./modules/task/task.routes');
const rateCalculatorRoutes = require('./modules/rateCalculator/rateCalculator.routes');
const intakeRoutes = require('./modules/intake/intake.routes');
const companyRoutes = require('./modules/company/company.routes');
const supplierRoutes = require('./modules/supplier/supplier.routes');
const billingRoutes = require('./modules/billing/billing.routes');
const reportsRoutes = require('./modules/reports/reports.routes');
const booksRoutes = require('./modules/books/books.routes');
const bankRoutes = require('./modules/bank/bank.routes');
const formFieldsRoutes = require('./modules/formFields/formFields.routes');
const purchasesRoutes = require('./modules/purchases/purchases.routes');
const auditTrail = require('./middlewares/auditTrail');
const ApiError = require('./utils/ApiError');
const upload = require('./middlewares/upload');
const env = require('./config/env');

const app = express();

// Behind Render/Vercel the client IP is in X-Forwarded-For (one proxy hop).
// Needed for login rate limiting and audit log IPs.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));


app.use((req, res, next) => {
  applyCorsHeaders(req, res);
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
// Orders, customers and saved products can carry inline product images, so
// those routes accept large bodies; everything else stays small.
const LARGE_BODY_ROUTES = /^\/api\/(sales-orders|customers|sales-settings|intake)(\/|$)/;
function jsonParser(limit) {
  return express.json({
    limit,
    verify(req, _res, buf) {
      if (req.originalUrl.split('?')[0] === '/api/intake/whatsapp') {
        req.rawBody = buf;
      }
    },
  });
}
const largeJson = jsonParser('8mb');
const smallJson = jsonParser('1mb');
app.use((req, res, next) => (LARGE_BODY_ROUTES.test(req.originalUrl.split('?')[0]) ? largeJson : smallJson)(req, res, next));
app.use(cookieParser());
// Only the public folders are served from disk. Order attachments
// (sales-orders/) and customer messages' files (intake/) go through the
// authenticated download routes. Checked on the decoded path, so %2D or %5C
// tricks cannot reach a private folder.
const PUBLIC_UPLOAD_FOLDERS = new Set(['products', 'artwork', 'misc']);
function publicUploadsOnly(req, res, next) {
  let decoded;
  try {
    decoded = decodeURIComponent(req.path);
  } catch {
    return res.status(404).end();
  }
  const parts = decoded.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length < 2 || parts.some((part) => part === '.' || part === '..') || !PUBLIC_UPLOAD_FOLDERS.has(parts[0])) {
    return res.status(404).end();
  }
  next();
}
app.use(
  '/uploads',
  publicUploadsOnly,
  express.static(env.uploadsDir, {
    dotfiles: 'deny',
    index: false,
    setHeaders(res, filePath) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
      if (!upload.IMAGE_EXT.has(path.extname(filePath).toLowerCase())) {
        res.setHeader('Content-Disposition', 'attachment');
      }
    },
  })
);

app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Sinopec API is running' });
});

app.use('/api', auditTrail);
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/permissions', permissionRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/machines', machineRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/sales-orders', salesOrderRoutes);
app.use('/api/sales-settings', salesSettingsRoutes);
app.use('/api/production', productionRoutes);
app.use('/api/registers', registerRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/audit-logs', auditRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/rate-calculator', rateCalculatorRoutes);
app.use('/api/intake', intakeRoutes);
app.use('/api/company-settings', companyRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/books', booksRoutes);
app.use('/api/bank', bankRoutes);
app.use('/api/form-fields', formFieldsRoutes);
app.use('/api/purchases', purchasesRoutes);

app.use((req, res, next) => {
  next(new ApiError(404, 'Route not found'));
});

app.use(errorHandler);

module.exports = app;
