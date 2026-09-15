const ApiError = require('../utils/ApiError');
const { hasPermission } = require('../utils/permissions');

function authorize(...requiredPermissions) {
  return (req, res, next) => {
    if (!req.user) {
      return next(new ApiError(401, 'Authentication required'));
    }

    const allowed = requiredPermissions.every((permission) => hasPermission(req.user, permission));
    if (!allowed) {
      return next(new ApiError(403, 'You do not have permission to perform this action'));
    }

    return next();
  };
}

authorize.any = (...permissions) => (req, res, next) => {
  if (!req.user) {
    return next(new ApiError(401, 'Authentication required'));
  }

  const allowed = permissions.some((permission) => hasPermission(req.user, permission));
  if (!allowed) {
    return next(new ApiError(403, 'You do not have permission to perform this action'));
  }

  return next();
};

module.exports = authorize;
