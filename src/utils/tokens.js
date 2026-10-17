const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { COOKIES } = require('../config/constants');

function signAccessToken(payload) {
  return jwt.sign(payload, env.jwtAccessSecret, { expiresIn: env.accessTokenTtl, jwtid: crypto.randomUUID() });
}

function signRefreshToken(payload) {
  return jwt.sign(payload, env.jwtRefreshSecret, { expiresIn: env.refreshTokenTtl, jwtid: crypto.randomUUID() });
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.jwtAccessSecret);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, env.jwtRefreshSecret);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Must agree with how jsonwebtoken reads the same TTL (seconds when bare).
function parseDurationMs(value) {
  if (typeof value === 'number') return value * 1000;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const match = text.match(/^(\d+)\s*([smhdw])$/i);
  if (!match) throw new Error(`Unsupported token TTL "${value}". Use e.g. 15m, 12h, 7d or 2w`);
  const map = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000, w: 7 * 24 * 60 * 60 * 1000 };
  return Number(match[1]) * map[match[2].toLowerCase()];
}

// Fail at startup, not on the first login.
parseDurationMs(env.accessTokenTtl);
parseDurationMs(env.refreshTokenTtl);

// SameSite=Lax keeps the auth cookies off cross-site POSTs, which is the CSRF
// protection. The production frontend calls /api same-origin through the
// Vercel rewrite, so Lax works there. Set COOKIE_SAMESITE=none only if a
// browser app on another site must call the API directly.
function useCrossSiteCookies() {
  return String(process.env.COOKIE_SAMESITE || '').toLowerCase() === 'none';
}

function baseCookieOptions() {
  const crossSite = useCrossSiteCookies();
  return {
    httpOnly: true,
    secure: crossSite || env.isProd,
    sameSite: crossSite ? 'none' : 'lax',
    path: '/',
  };
}

function cookieOptions(maxAge) {
  return { ...baseCookieOptions(), maxAge };
}

function setAuthCookies(res, accessToken, refreshToken) {
  res.cookie(COOKIES.ACCESS, accessToken, cookieOptions(parseDurationMs(env.accessTokenTtl)));
  res.cookie(COOKIES.REFRESH, refreshToken, cookieOptions(parseDurationMs(env.refreshTokenTtl)));
}

function clearAuthCookies(res) {
  const base = baseCookieOptions();
  res.clearCookie(COOKIES.ACCESS, base);
  res.clearCookie(COOKIES.REFRESH, base);
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashToken,
  parseDurationMs,
  setAuthCookies,
  clearAuthCookies,
};
