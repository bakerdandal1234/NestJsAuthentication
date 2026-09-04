import 'dotenv/config';
import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { LoginHistory } from '../users/entities/login-history.entity';
import { Session } from '../sessions/entities/session.entity';
import { Role } from '../users/entities/role.entity';
import { Permission } from '../users/entities/permission.entity';
import { UserRole } from '../users/entities/user-role.entity';
import { RolePermission } from '../users/entities/role-permission.entity';
/**
 * Standalone DataSource for the TypeORM CLI (migration:generate / migration:run).
 * This is separate from typeorm.config.ts (which NestJS uses at runtime via
 * TypeOrmModule.forRootAsync) because the CLI cannot consume a NestJS
 * registerAs() factory directly — it needs a plain DataSource instance.
 * Keep the connection settings and entities list in sync with typeorm.config.ts.
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: [User, LoginHistory, Session,Role,Permission,UserRole,RolePermission],
  migrations: ['src/migrations/*.ts'],
  synchronize: false,
  logging: true,
});
