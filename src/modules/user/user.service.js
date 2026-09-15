const bcrypt = require('bcryptjs');
const { ROLE_SLUGS } = require('../../config/constants');
const ApiError = require('../../utils/ApiError');
const { toPublicUser } = require('../../utils/permissions');
const roleRepo = require('../role/role.repo');
const userRepo = require('./user.repo');

async function assertRoleChangeAllowed(actor, targetUser, nextRole) {
  const actorIsSuperAdmin = actor.role?.slug === ROLE_SLUGS.SUPER_ADMIN;
  const targetIsSuperAdmin = targetUser.role?.slug === ROLE_SLUGS.SUPER_ADMIN;
  const nextIsSuperAdmin = nextRole?.slug === ROLE_SLUGS.SUPER_ADMIN;

  if ((targetIsSuperAdmin || nextIsSuperAdmin) && !actorIsSuperAdmin) {
    throw new ApiError(403, 'Only a Super Admin can manage Super Admin accounts');
  }
}

async function assertNotLastSuperAdmin(user, nextRoleSlug, nextIsActive) {
  const isSuperAdmin = user.role?.slug === ROLE_SLUGS.SUPER_ADMIN;
  if (!isSuperAdmin) return;

  const losingRole = nextRoleSlug && nextRoleSlug !== ROLE_SLUGS.SUPER_ADMIN;
  const deactivating = nextIsActive === false;

  if (!losingRole && !deactivating) return;

  const remaining = await userRepo.countByRole(user.role._id);
  if (remaining <= 1) {
    throw new ApiError(400, 'The last Super Admin cannot be removed or deactivated');
  }
}

async function listUsers() {
  const users = await userRepo.findAllWithRole();
  return users.map(toPublicUser);
}

async function listDirectory() {
  const users = await userRepo.findAllWithRole();
  return users.map((user) => ({
    id: String(user._id),
    fullName: user.fullName,
    username: user.username,
    isActive: user.isActive,
    role: user.role
      ? {
          id: String(user.role._id),
          name: user.role.name,
          slug: user.role.slug,
        }
      : null,
  }));
}

async function createUser(actor, payload) {
  const username = payload.username.toLowerCase().trim();
  const existing = await userRepo.findByUsername(username);
  if (existing) {
    throw new ApiError(409, 'Username is already taken');
  }

  const role = await roleRepo.findByIdWithPermissions(payload.roleId);
  if (!role) {
    throw new ApiError(400, 'Role not found');
  }

  await assertRoleChangeAllowed(actor, { role: { slug: null } }, role);

  const passwordHash = await bcrypt.hash(payload.password, 10);
  const user = await userRepo.create({
    username,
    passwordHash,
    fullName: payload.fullName.trim(),
    role: role._id,
    isActive: payload.isActive !== false,
  });

  const created = await userRepo.findByIdWithRole(user._id);
  return toPublicUser(created);
}

async function updateUser(actor, userId, payload) {
  const user = await userRepo.findByIdWithRole(userId);
  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  const updates = {};

  if (payload.fullName !== undefined) {
    updates.fullName = payload.fullName.trim();
  }

  if (payload.username !== undefined) {
    const username = payload.username.toLowerCase().trim();
    const existing = await userRepo.findByUsername(username);
    if (existing && String(existing._id) !== String(user._id)) {
      throw new ApiError(409, 'Username is already taken');
    }
    updates.username = username;
  }

  let nextRole = user.role;
  if (payload.roleId) {
    nextRole = await roleRepo.findByIdWithPermissions(payload.roleId);
    if (!nextRole) {
      throw new ApiError(400, 'Role not found');
    }
    updates.role = nextRole._id;
  }

  if (payload.isActive !== undefined) {
    updates.isActive = payload.isActive;
  }

  if (payload.password) {
    updates.passwordHash = await bcrypt.hash(payload.password, 10);
  }

  await assertRoleChangeAllowed(actor, user, nextRole);
  await assertNotLastSuperAdmin(
    user,
    nextRole?.slug,
    payload.isActive !== undefined ? payload.isActive : user.isActive
  );

  const updated = await userRepo.updateById(userId, updates);
  return toPublicUser(updated);
}

async function deleteUser(actor, userId) {
  const user = await userRepo.findByIdWithRole(userId);
  if (!user) {
    throw new ApiError(404, 'User not found');
  }

  if (String(actor._id) === String(user._id)) {
    throw new ApiError(400, 'You cannot delete your own account');
  }

  await assertRoleChangeAllowed(actor, user, user.role);
  await assertNotLastSuperAdmin(user, null, false);

  await userRepo.deleteById(userId);
}

module.exports = {
  listUsers,
  listDirectory,
  createUser,
  updateUser,
  deleteUser,
};
