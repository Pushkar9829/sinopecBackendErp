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
  toPublicUser,
};
