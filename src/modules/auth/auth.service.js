const bcrypt = require('bcryptjs');
const env = require('../../config/env');
const { COOKIES } = require('../../config/constants');
const ApiError = require('../../utils/ApiError');
const { toPublicUser } = require('../../utils/permissions');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  parseDurationMs,
  setAuthCookies,
  clearAuthCookies,
} = require('../../utils/tokens');
const userRepo = require('../user/user.repo');
const authRepo = require('./auth.repo');

function tokenPayload(user) {
  return {
    sub: String(user._id),
    role: user.role?.slug,
  };
}

async function issueSession(res, user) {
  const accessToken = signAccessToken(tokenPayload(user));
  const refreshToken = signRefreshToken(tokenPayload(user));

  await authRepo.create({
    user: user._id,
    tokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + parseDurationMs(env.refreshTokenTtl)),
  });

  setAuthCookies(res, accessToken, refreshToken);
}

async function login(res, username, password) {
  const user = await userRepo.findByUsername(username);
  if (!user) {
    throw new ApiError(401, 'Invalid username or password');
  }

  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) {
    throw new ApiError(401, 'Invalid username or password');
  }

  if (!user.isActive) {
    throw new ApiError(403, 'Account is deactivated');
  }

  await userRepo.updateById(user._id, { lastLoginAt: new Date() });
  user.lastLoginAt = new Date();

  await issueSession(res, user);
  return toPublicUser(user);
}

async function logout(req, res) {
  const refreshToken = req.cookies?.[COOKIES.REFRESH];
  if (refreshToken) {
    await authRepo.revokeByHash(hashToken(refreshToken));
  }
  clearAuthCookies(res);
}

async function refresh(req, res) {
  const refreshToken = req.cookies?.[COOKIES.REFRESH];
  if (!refreshToken) {
    throw new ApiError(401, 'Refresh token missing');
  }

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    clearAuthCookies(res);
    throw new ApiError(401, 'Invalid or expired refresh token');
  }

  const stored = await authRepo.findValidByHash(hashToken(refreshToken));
  if (!stored) {
    clearAuthCookies(res);
    throw new ApiError(401, 'Refresh token has been revoked');
  }

  const user = await userRepo.findByIdWithRole(payload.sub);
  if (!user || !user.isActive) {
    await authRepo.revokeByHash(hashToken(refreshToken));
    clearAuthCookies(res);
    throw new ApiError(401, 'Account is inactive or no longer exists');
  }

  await authRepo.revokeByHash(hashToken(refreshToken));
  await issueSession(res, user);
  return toPublicUser(user);
}

function me(user) {
  return toPublicUser(user);
}

module.exports = {
  login,
  logout,
  refresh,
  me,
};
