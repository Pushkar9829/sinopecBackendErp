const { ROLE_SLUGS } = require('../config/constants');

function collectPermissionKeys(role) {
  if (!role) return [];
  return (role.permissions || [])
    .map((permission) => (typeof permission === 'string' ? permission : permission.key))
    .filter(Boolean);
}

function matchesPermission(ownedKeys, requiredKey) {
  if (ownedKeys.includes(requiredKey)) return true;

  const parts = requiredKey.split(':');
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    const wildcard = [...parts.slice(0, i), '*'].join(':');
    if (ownedKeys.includes(wildcard)) return true;
  }

  return ownedKeys.includes('*');
}

function hasPermission(user, requiredKey) {
  if (!user?.role) return false;
  if (user.role.slug === ROLE_SLUGS.SUPER_ADMIN) return true;
  return matchesPermission(collectPermissionKeys(user.role), requiredKey);
}

function isSuperAdmin(user) {
  return user?.role?.slug === ROLE_SLUGS.SUPER_ADMIN;
}

// Keys in `role` that `actor` does not hold themselves. A non-Super-Admin may
// only hand out, or manage people holding, access they already have.
function permissionsBeyond(actor, role) {
  if (isSuperAdmin(actor)) return [];
  if (role?.slug === ROLE_SLUGS.SUPER_ADMIN) return ['*'];
  const owned = collectPermissionKeys(actor?.role);
  return collectPermissionKeys(role).filter((key) => !matchesPermission(owned, key));
}

// "false"/"0" must mean false; Boolean("false") is true.
function toBool(value) {
  if (typeof value === 'string') return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function toPublicUser(user) {
  const role = user.role;
  const permissions = role?.slug === ROLE_SLUGS.SUPER_ADMIN
    ? ['*']
    : collectPermissionKeys(role);

  return {
    id: String(user._id),
    username: user.username,
    fullName: user.fullName,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt,
    role: role
      ? {
          id: String(role._id),
          name: role.name,
          slug: role.slug,
        }
      : null,
    permissions,
  };
}

module.exports = {
  collectPermissionKeys,
  matchesPermission,
  hasPermission,
  isSuperAdmin,
  permissionsBeyond,
  toBool,
  toPublicUser,
};
