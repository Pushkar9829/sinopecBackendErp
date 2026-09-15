const env = require('./env');

const allowedOrigins = new Set([
  ...env.clientOrigins,
  'http://localhost:5173',
  'https://sinopecerpfrontend.vercel.app',
]);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;

  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return true;
  }

  if (url.protocol !== 'https:') return false;

  const host = url.hostname;
  if (host === 'sinopecerpfrontend.vercel.app') return true;
  if (host.startsWith('sinopecerpfrontend-') && host.endsWith('.vercel.app')) return true;
  if (host.endsWith('-pushkar9829s-projects.vercel.app')) return true;
  return false;
}

function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (!origin || !isAllowedOrigin(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
  return true;
}

module.exports = {
  isAllowedOrigin,
  applyCorsHeaders,
};
