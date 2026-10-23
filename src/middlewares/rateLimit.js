const ApiError = require('../utils/ApiError');

// Small fixed-window limiter kept in process memory. Good enough for a single
// API instance; move the buckets to Redis/Mongo if the API is ever scaled out.
function rateLimit({ windowMs, max, key, message = 'Too many attempts. Try again later.', skipSuccessful = false }) {
  const buckets = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(id);
    }
  }, windowMs);
  sweep.unref();

  return function limit(req, res, next) {
    const id = key(req);
    const now = Date.now();
    let bucket = buckets.get(id);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(id, bucket);
    }

    if (bucket.count >= max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return next(new ApiError(429, message));
    }

    bucket.count += 1;
    if (skipSuccessful) {
      res.on('finish', () => {
        if (res.statusCode < 400 && bucket.count > 0) bucket.count -= 1;
      });
    }
    next();
  };
}

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function loginUsername(req) {
  const value = req.body?.username;
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

const FIFTEEN_MINUTES = 15 * 60 * 1000;

// Failed logins per username from one IP, and per IP (any username). The
// username bucket is keyed on the IP too, so someone guessing from elsewhere
// cannot lock the real user out of their own account.
const loginLimiters = [
  rateLimit({
    windowMs: FIFTEEN_MINUTES,
    max: 10,
    skipSuccessful: true,
    key: (req) => `user:${loginUsername(req)}|${clientIp(req)}`,
    message: 'Too many failed sign-in attempts for this user. Try again in 15 minutes.',
  }),
  rateLimit({
    windowMs: FIFTEEN_MINUTES,
    max: 50,
    skipSuccessful: true,
    key: (req) => `ip:${clientIp(req)}`,
    message: 'Too many failed sign-in attempts. Try again in 15 minutes.',
  }),
];

// Sign-out writes an audit row each time; keep it from being spammed.
const logoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  key: (req) => `logout:${clientIp(req)}`,
});

const refreshLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  key: (req) => `refresh:${clientIp(req)}`,
});

module.exports = { rateLimit, loginLimiters, refreshLimiter, logoutLimiter };
