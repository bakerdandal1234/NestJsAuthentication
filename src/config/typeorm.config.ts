import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { LoginHistory } from '../users/entities/login-history.entity';
import { Session } from '../sessions/entities/session.entity';
import { Role } from '../users/entities/role.entity';
import { Permission } from '../users/entities/permission.entity';
import { UserRole } from '../users/entities/user-role.entity';
import { RolePermission } from '../users/entities/role-permission.entity';
export default registerAs('database', (): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: [User, LoginHistory, Session,Role,Permission,UserRole,RolePermission],

  // Fully migration-based now (both dev and production) — synchronize is
  // never used, to avoid drift between the schema TypeORM would infer from
  // entities and what the migration history actually says happened.
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
  ssl:
    process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
}));
