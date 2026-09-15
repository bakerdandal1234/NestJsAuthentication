import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import * as bcrypt from 'bcryptjs';
import { AppModule } from '../app.module';
import { UsersService } from '../users/users.service';
import { AuthorizationService } from '../authorization/authorization.service';

/**
 * Seeds a single bootstrap admin account, from ADMIN_EMAIL / ADMIN_PASSWORD
 * environment variables (never hardcoded here).
 *
 * Why this is needed: every route on AuthorizationController is guarded by
 * @Permissions(...), so on a fresh database there is no account holding any
 * permission that could call them (not even to create the first one) —
 * a bootstrap/chicken-and-egg problem. This script creates (or reuses) one
 * user directly via UsersService/AuthorizationService, bypassing HTTP and
 * the Guards entirely, then assigns it the 'admin' role.
 *
 * Requires `npm run seed:authorization` to have been run first (that's what
 * creates the 'admin' role and links it to every permission).
 *
 * Safe to run more than once — reuses the user if the email already exists,
 * and assignRoleByName() is itself idempotent (no duplicate role link).
 *
 * Usage:
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='Str0ng!Pass1' npm run seed:admin
 */

const SALT_ROUNDS = 12; // matches AuthService.SALT_ROUNDS

async function seed() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.error(
      'ADMIN_EMAIL and ADMIN_PASSWORD environment variables are required, e.g.\n' +
        "  ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='Str0ng!Pass1' npm run seed:admin",
    );
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const usersService = app.get(UsersService);
  const authorizationService = app.get(AuthorizationService);

  try {
    let user = await usersService.findByEmail(email);

    if (!user) {
      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
      user = await usersService.create({
        email,
        password: passwordHash,
        // Skip the normal register() email-verification flow — this
        // account is provisioned directly, not through /auth/register.
        isEmailVerified: true,
      });
      console.log(`Created admin user: ${user.email}`);
    } else {
      console.log(`User already exists, reusing: ${user.email}`);
    }

    await authorizationService.assignRoleByName(user.id, 'admin');
    console.log(`Linked '${user.email}' to the 'admin' role.`);

    console.log('Admin seed completed.');
  } finally {
    await app.close();
  }
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Admin seed failed:', err);
    process.exit(1);
  });
