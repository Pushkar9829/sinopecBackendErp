const { applyCorsHeaders } = require('../config/cors');
const env = require('../config/env');

function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  applyCorsHeaders(req, res);

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, message: 'File is too large (max 15 MB)' });
  }

  if (err.name === 'ValidationError') {
    return res.status(400).json({ success: false, message: err.message });
  }

  const statusCode = err.statusCode || 500;
  const message = statusCode === 500 && env.isProd ? 'Internal server error' : err.message;
  res.status(statusCode).json({
    success: false,
    message,
  });
}

module.exports = errorHandler;
