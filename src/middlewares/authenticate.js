const { COOKIES } = require('../config/constants');
const authRepo = require('../modules/auth/auth.repo');
const userRepo = require('../modules/user/user.repo');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { verifyAccessToken } = require('../utils/tokens');

function readAccessToken(req) {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  return req.cookies?.[COOKIES.ACCESS] || null;
}

const authenticate = asyncHandler(async (req, res, next) => {
  const token = readAccessToken(req);
  if (!token) {
    throw new ApiError(401, 'Authentication required');
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw new ApiError(401, 'Invalid or expired access token');
  }

  const user = await userRepo.findByIdWithRole(payload.sub);
  if (!user || !user.isActive) {
    throw new ApiError(401, 'Account is inactive or no longer exists');
  }
  // Tokens from before a password change / sign-out-everywhere, or from a
  // browser that signed out, no longer count.
  if ((payload.tv || 0) !== (user.tokenVersion || 0)) {
    throw new ApiError(401, 'Session has ended. Sign in again.');
  }
  if (payload.jti && (await authRepo.isAccessJtiRevoked(payload.jti))) {
    throw new ApiError(401, 'Session has ended. Sign in again.');
  }

  req.user = user;
  next();
});

module.exports = authenticate;
