const cookieParser = require('cookie-parser');
const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const { applyCorsHeaders, isAllowedOrigin } = require('./config/cors');
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
const analyticsRoutes = require('./modules/analytics/analytics.routes');
const ApiError = require('./utils/ApiError');

const app = express();

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204,
};

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
app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Sinopec API is running' });
});

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
app.use('/api/analytics', analyticsRoutes);

app.use((req, res, next) => {
  next(new ApiError(404, 'Route not found'));
});

app.use(errorHandler);

module.exports = app;
