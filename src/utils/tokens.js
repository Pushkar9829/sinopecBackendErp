const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { COOKIES } = require('../config/constants');

function signAccessToken(payload) {
  return jwt.sign(payload, env.jwtAccessSecret, { expiresIn: env.accessTokenTtl });
}

function signRefreshToken(payload) {
  return jwt.sign(payload, env.jwtRefreshSecret, { expiresIn: env.refreshTokenTtl });
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

function parseDurationMs(value) {
  if (typeof value === 'number') return value;
  const match = String(value).match(/^(\d+)([smhd])$/);
  if (!match) return 15 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = match[2];
  const map = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return amount * map[unit];
}

function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: env.isProd,
    sameSite: 'lax',
    path: '/',
    maxAge,
  };
}

function setAuthCookies(res, accessToken, refreshToken) {
  res.cookie(COOKIES.ACCESS, accessToken, cookieOptions(parseDurationMs(env.accessTokenTtl)));
  res.cookie(COOKIES.REFRESH, refreshToken, cookieOptions(parseDurationMs(env.refreshTokenTtl)));
}

function clearAuthCookies(res) {
  const base = { httpOnly: true, secure: env.isProd, sameSite: 'lax', path: '/' };
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
