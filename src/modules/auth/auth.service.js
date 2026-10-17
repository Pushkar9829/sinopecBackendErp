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

// A refresh token reused this long after it was rotated is treated as stolen.
// Inside the window it is most likely a second tab racing the first one.
const REUSE_GRACE_MS = 30 * 1000;

// Used when the username doesn't exist, so a miss costs the same bcrypt time
// as a wrong password and usernames can't be probed by timing.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 10);

async function issueSession(res, user) {
  const accessToken = signAccessToken(tokenPayload(user));
  const refreshToken = signRefreshToken(tokenPayload(user));

  await authRepo.create({
    user: user._id,
    tokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + parseDurationMs(env.refreshTokenTtl)),
  });

  setAuthCookies(res, accessToken, refreshToken);
  return { accessToken };
}

// The refresh token lives only in its httpOnly cookie. The short-lived access
// token is also returned so the client can keep it in memory as a Bearer
// fallback; it is never persisted by the client.
function withTokens(user, tokens) {
  return {
    ...toPublicUser(user),
    accessToken: tokens.accessToken,
  };
}

function readRefreshCookie(req) {
  const value = req.cookies?.[COOKIES.REFRESH];
  return typeof value === 'string' && value ? value : null;
}

async function login(res, username, password) {
  const user = await userRepo.findByUsername(username);
  const matches = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !matches) {
    throw new ApiError(401, 'Invalid username or password');
  }

  if (!user.isActive) {
    throw new ApiError(403, 'Account is deactivated');
  }

  await userRepo.updateById(user._id, { lastLoginAt: new Date() });
  user.lastLoginAt = new Date();

  const tokens = await issueSession(res, user);
  return withTokens(user, tokens);
}

async function logout(req, res) {
  const refreshToken = readRefreshCookie(req);
  if (refreshToken) {
    await authRepo.revokeByHash(hashToken(refreshToken));
  }
  clearAuthCookies(res);
}

async function refresh(req, res) {
  const refreshToken = readRefreshCookie(req);
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

  const tokenHash = hashToken(refreshToken);
  const claimed = await authRepo.claimByHash(tokenHash);
  if (!claimed) {
    const stored = await authRepo.findByHash(tokenHash);
    const usedAt = stored?.revokedAt ? stored.revokedAt.getTime() : 0;
    if (usedAt && Date.now() - usedAt < REUSE_GRACE_MS) {
      // Another tab just rotated this token and its new cookie is already in
      // the shared jar. Don't clear cookies, or that tab is logged out too.
      throw new ApiError(401, 'Refresh token was just rotated');
    }
    if (stored) {
      // An old, already-rotated token came back: assume it was stolen and
      // end every session for this user.
      await authRepo.revokeAllForUser(stored.user);
    }
    clearAuthCookies(res);
    throw new ApiError(401, 'Refresh token has been revoked');
  }

  const user = await userRepo.findByIdWithRole(payload.sub);
  if (!user || !user.isActive) {
    clearAuthCookies(res);
    throw new ApiError(401, 'Account is inactive or no longer exists');
  }

  const tokens = await issueSession(res, user);
  return withTokens(user, tokens);
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
