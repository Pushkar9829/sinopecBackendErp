const { COOKIES } = require('../config/constants');
const userRepo = require('../modules/user/user.repo');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { verifyAccessToken } = require('../utils/tokens');

const authenticate = asyncHandler(async (req, res, next) => {
  const token = req.cookies?.[COOKIES.ACCESS];
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
