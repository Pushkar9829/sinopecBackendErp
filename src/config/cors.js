const env = require('./env');

const allowedOrigins = new Set([
  ...env.clientOrigins,
  ...(env.isProd ? [] : ['http://localhost:5173']),
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

  // Any local dev server may call a dev API, never the production one.
  if (!env.isProd && url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return true;
  }

  // Everything else must be listed exactly in CLIENT_ORIGIN. No suffix or
  // prefix matching on *.vercel.app: anyone can register a matching project.
  // The Vercel frontend calls /api same-origin through its rewrite, so it does
  // not need CORS at all.
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
