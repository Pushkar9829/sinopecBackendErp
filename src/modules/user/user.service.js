const bcrypt = require('bcryptjs');
const { ROLE_SLUGS } = require('../../config/constants');
const ApiError = require('../../utils/ApiError');
const { permissionsBeyond, toBool, toPublicUser } = require('../../utils/permissions');
const authRepo = require('../auth/auth.repo');
const authService = require('../auth/auth.service');
const roleRepo = require('../role/role.repo');
const userRepo = require('./user.repo');

async function assertRoleChangeAllowed(actor, targetUser, nextRole) {
  const actorIsSuperAdmin = actor.role?.slug === ROLE_SLUGS.SUPER_ADMIN;
  const targetIsSuperAdmin = targetUser.role?.slug === ROLE_SLUGS.SUPER_ADMIN;
  const nextIsSuperAdmin = nextRole?.slug === ROLE_SLUGS.SUPER_ADMIN;

  if ((targetIsSuperAdmin || nextIsSuperAdmin) && !actorIsSuperAdmin) {
    throw new ApiError(403, 'Only a Super Admin can manage Super Admin accounts');
  }

  // Without this, anyone with users:update could reset the password of a
  // user with more access (say roles:update) and sign in as them.
  if (targetUser.role?.permissions && permissionsBeyond(actor, targetUser.role).length) {
    throw new ApiError(403, 'You cannot manage a user who has access you do not have');
  }
  if (nextRole && permissionsBeyond(actor, nextRole).length) {
    throw new ApiError(403, 'You cannot give a role that has access you do not have');
  }
}

async function assertNotLastSuperAdmin(user, nextRoleSlug, nextIsActive) {
  const isSuperAdmin = user.role?.slug === ROLE_SLUGS.SUPER_ADMIN;
  if (!isSuperAdmin) return;

  const losingRole = nextRoleSlug && nextRoleSlug !== ROLE_SLUGS.SUPER_ADMIN;
  const deactivating = nextIsActive === false;

  if (!losingRole && !deactivating) return;
  if (user.isActive === false) return;

  const remaining = await userRepo.countActiveByRole(user.role._id);
  if (remaining <= 1) {
    throw new ApiError(400, 'The last Super Admin cannot be removed or deactivated');
  }
}

async function listUsers() {
  const users = await userRepo.findAllWithRole();
  return users.map(toPublicUser);
}

// People who can be assigned to stages and work. Floor roles read this, so it
// leaves out Super Admin accounts and sign-in names.
async function listDirectory() {
  const users = await userRepo.findAllWithRole();
  return users.filter((user) => user.role?.slug !== ROLE_SLUGS.SUPER_ADMIN).map((user) => ({
    id: String(user._id),
    fullName: user.fullName,
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

function assertStrings(payload, fields) {
  for (const field of fields) {
    if (payload[field] !== undefined && typeof payload[field] !== 'string') {
      throw new ApiError(400, `${field} must be text`);
    }
  }
}

async function createUser(actor, payload) {
  assertStrings(payload, ['username', 'password', 'fullName']);
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
    isActive: payload.isActive === undefined ? true : toBool(payload.isActive),
  });

  const created = await userRepo.findByIdWithRole(user._id);
  return toPublicUser(created);
}

async function updateUser(actor, userId, rawPayload) {
  const payload = { ...rawPayload };
  if (payload.isActive !== undefined) payload.isActive = toBool(payload.isActive);
  assertStrings(payload, ['username', 'password', 'fullName']);
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

  const self = String(actor._id) === String(user._id);
  if (payload.password) {
    // Your own password needs the current one, so a borrowed signed-in
    // browser can't be used to take the account over.
    if (self) {
      const current = typeof payload.currentPassword === 'string' ? payload.currentPassword : '';
      if (!current || !(await bcrypt.compare(current, user.passwordHash || ''))) {
        throw new ApiError(400, 'Current password is wrong');
      }
    }
    updates.passwordHash = await bcrypt.hash(payload.password, 10);
  }

  if (self && payload.isActive === false) {
    throw new ApiError(400, 'You cannot deactivate your own account');
  }
  if (self && updates.role && String(updates.role) !== String(user.role?._id)) {
    throw new ApiError(400, 'You cannot change your own role');
  }

  await assertRoleChangeAllowed(actor, user, nextRole);
  await assertNotLastSuperAdmin(
    user,
    nextRole?.slug,
    payload.isActive !== undefined ? payload.isActive : user.isActive
  );

  const updated = await userRepo.updateById(userId, updates);
  if (user.role?.slug === ROLE_SLUGS.SUPER_ADMIN && (updates.role || updates.isActive === false)) {
    const left = await userRepo.countActiveByRole(user.role._id);
    if (left < 1) {
      await userRepo.updateById(userId, { role: user.role._id, isActive: user.isActive });
      throw new ApiError(409, 'Another change just removed the other Super Admin. At least one must remain.');
    }
  }
  if (payload.password) {
    await authService.endAllSessions(user._id);
  }
  if (payload.isActive === false && user.isActive !== false) {
    await releaseTasks(user);
  }
  return toPublicUser(updated);
}

async function releaseTasks(user) {
  try {
    await require('../task/task.repo').releaseAssignee(user._id, user.role?.slug);
  } catch (error) {
    console.error('Returning tasks to the team queue failed', error.message);
  }
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
  await authRepo.revokeAllForUser(user._id).catch(() => {});
  await releaseTasks(user);
}

module.exports = {
  listUsers,
  listDirectory,
  createUser,
  updateUser,
  deleteUser,
};
