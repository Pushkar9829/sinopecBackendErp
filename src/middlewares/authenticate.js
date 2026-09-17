const { COOKIES } = require('../config/constants');
const userRepo = require('../modules/user/user.repo');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { verifyAccessToken } = require('../utils/tokens');

function readAccessToken(req) {
  const header = req.headers.authorization || req.headers.Authorization;
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

  req.user = user;
  next();
});

module.exports = authenticate;
