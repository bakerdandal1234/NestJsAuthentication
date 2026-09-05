import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AuthorizationService } from '../authorization/authorization.service';

/**
 * Seeds default RBAC data (roles, permissions, role<->permission links).
 *
 * This is intentionally a plain script, NOT a TypeORM migration:
 * migration:generate only diffs entity metadata (columns/constraints)
 * against the live schema to produce DDL — it has no concept of "insert
 * these specific rows", so seed data can never come out of that command.
 * Schema changes (tables/columns/constraints) still belong in entities +
 * `npm run migration:generate`; this script only ever inserts data,
 * reusing AuthorizationService so it obeys the exact same rules
 * (duplicate checks, etc.) as the real API.
 *
 * Safe to run more than once — every step checks for an existing row
 * before creating one.
 *
 * Usage: npm run seed:authorization
 */

const DEFAULT_ROLES = [
  { name: 'user', description: 'Default role assigned to every registered user' },
  { name: 'moderator', description: 'Elevated role with limited administrative (read-only) access' },
  { name: 'admin', description: 'Full administrative access' },
];

const DEFAULT_PERMISSIONS = [
  { resource: 'roles', action: 'read', description: 'View roles' },
  { resource: 'roles', action: 'create', description: 'Create roles' },
  { resource: 'roles', action: 'update', description: 'Update roles' },
  { resource: 'roles', action: 'delete', description: 'Delete roles' },
  { resource: 'roles', action: 'assign-permission', description: 'Assign or remove a permission on a role' },
  { resource: 'permissions', action: 'read', description: 'View permissions' },
  { resource: 'permissions', action: 'create', description: 'Create permissions' },
  { resource: 'permissions', action: 'update', description: 'Update permissions' },
  { resource: 'permissions', action: 'delete', description: 'Delete permissions' },
  { resource: 'users', action: 'read', description: "View a user's roles/permissions" },
  { resource: 'users', action: 'assign-role', description: 'Assign or remove a role on a user' },
  { resource: 'admin', action: 'ping', description: 'Access admin-only test endpoint' }
];

// Read-only resources that the 'moderator' role gets automatically.
const MODERATOR_READ_RESOURCES = new Set(['roles', 'permissions', 'users']);

async function seed() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const authorizationService = app.get(AuthorizationService);

  try {
    // --- Roles: create any that don't exist yet ---
    const existingRoles = await authorizationService.findAllRoles();
    const roleByName = new Map(existingRoles.map((role) => [role.name, role]));

    for (const roleDef of DEFAULT_ROLES) {
      if (!roleByName.has(roleDef.name)) {
        const created = await authorizationService.createRole(roleDef);
        roleByName.set(created.name, created);
        console.log(`Created role: ${created.name}`);
      }
    }

    // --- Permissions: create any that don't exist yet ---
    const existingPermissions = await authorizationService.findAllPermissions();
    const permKey = (p: { resource: string; action: string }) => `${p.resource}:${p.action}`;
    const permByKey = new Map(existingPermissions.map((p) => [permKey(p), p]));

    for (const permDef of DEFAULT_PERMISSIONS) {
      if (!permByKey.has(permKey(permDef))) {
        const created = await authorizationService.createPermission(permDef);
        permByKey.set(permKey(created), created);
        console.log(`Created permission: ${permKey(created)}`);
      }
    }

    // --- admin: every permission that exists ---
    const adminRole = roleByName.get('admin');
    if (adminRole) {
      for (const permission of permByKey.values()) {
        await authorizationService.assignPermissionToRole(adminRole.id, permission.id);
      }
      console.log(`Linked 'admin' to ${permByKey.size} permission(s).`);
    }

    // --- moderator: read-only across roles/permissions/users ---
    const moderatorRole = roleByName.get('moderator');
    if (moderatorRole) {
      let count = 0;
      for (const permission of permByKey.values()) {
        if (permission.action === 'read' && MODERATOR_READ_RESOURCES.has(permission.resource)) {
          await authorizationService.assignPermissionToRole(moderatorRole.id, permission.id);
          count += 1;
        }
      }
      console.log(`Linked 'moderator' to ${count} read-only permission(s).`);
    }

    // --- Bootstrap note ---
    // 'user' intentionally gets no permissions. To promote your first
    // account to admin after seeding, register normally (gets 'user'
    // automatically), then run in your DB:
    //   INSERT INTO user_roles (user_id, role_id)
    //   SELECT '<your-user-id>', id FROM roles WHERE name = 'admin';

    console.log('Authorization seed completed.');
  } finally {
    await app.close();
  }
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Authorization seed failed:', err);
    process.exit(1);
  });
