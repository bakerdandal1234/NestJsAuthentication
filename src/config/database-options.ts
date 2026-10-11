import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { User } from '../users/entities/user.entity';
import { LoginHistory } from '../users/entities/login-history.entity';
import { Session } from '../sessions/entities/session.entity';
import { Role } from '../users/entities/role.entity';
import { Permission } from '../users/entities/permission.entity';
import { UserRole } from '../users/entities/user-role.entity';
import { RolePermission } from '../users/entities/role-permission.entity';
import { StaffOAuthChallenge } from '../auth/staff-oauth-challenge.entity';
import { OAuthState } from '../auth/oauth-state.entity';
import { databaseTlsOptions } from './database-tls';

export const DATABASE_ENTITIES = [User, LoginHistory, Session, Role, Permission, UserRole, RolePermission, StaffOAuthChallenge, OAuthState];

export function databaseOptions(environment: NodeJS.ProcessEnv): PostgresConnectionOptions {
  assertDatabaseCredentials(environment);
  const port = Number(environment.DB_PORT ?? '5432');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DB_PORT must be an integer between 1 and 65535');
  }
  return {
    type: 'postgres', host: environment.DB_HOST, port,
    username: environment.DB_USERNAME, password: environment.DB_PASSWORD, database: environment.DB_NAME,
    entities: DATABASE_ENTITIES,
    synchronize: false, logging: environment.NODE_ENV === 'development',
    ssl: databaseTlsOptions(environment),
  };
}

function assertDatabaseCredentials(environment: NodeJS.ProcessEnv): void {
  for (const variable of ['DB_HOST', 'DB_USERNAME', 'DB_PASSWORD', 'DB_NAME']) {
    if (!environment[variable]?.trim()) {
      throw new Error(`${variable} must not be empty`);
    }
  }
}
