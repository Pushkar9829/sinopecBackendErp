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

  if (err.name === 'CastError') {
    return res.status(400).json({ success: false, message: `Invalid ${err.path || 'value'}` });
  }

  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'This request is too large. Upload images as files instead.' });
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'The request body is not valid JSON' });
  }

  if (err.code === 11000) {
    return res.status(409).json({ success: false, message: 'That record already exists' });
  }

  const statusCode = err.statusCode || 500;
  const message = statusCode === 500 && env.isProd ? 'Internal server error' : err.message;
  res.status(statusCode).json({
    success: false,
    message,
  });
}

module.exports = errorHandler;
