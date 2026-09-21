import { StaffOAuthChallenge } from '../auth/staff-oauth-challenge.entity';
import { Payment } from '../payments/entity/payment.entity';
import { Refund } from '../payments/entity/refund.entity';
import { StripeWebhookEvent } from '../payments/entity/stripe-webhook-event.entity';
import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { User } from '../users/entities/user.entity';
import { LoginHistory } from '../users/entities/login-history.entity';
import { Session } from '../sessions/entities/session.entity';
import { Role } from '../users/entities/role.entity';
import { Permission } from '../users/entities/permission.entity';
import { UserRole } from '../users/entities/user-role.entity';
import { RolePermission } from '../users/entities/role-permission.entity';
import { Category } from '../categories/entities/category.entity';
import { Product } from '../products/entities/product.entity';
import { Customer } from '../customers/entities/customer.entity';
import { Inventory } from '../inventory/entities/inventory.entity';
import { InventoryTransaction } from '../invertoryTansaction/entity/InventoryTransaction.entity';
import { OrderItem } from '../orders/entity/order-item.entity';
import { Order } from '../orders/entity/Order.entity';
import { CustomerAccount } from '../customer-auth/entities/customer-account.entity';
import { CustomerSession } from '../customer-auth/entities/customer-session.entity';
import { CustomerOAuthChallenge } from '../customer-auth/entities/customer-oauth-challenge.entity';
import { CustomerLoginHistory } from '../customer-auth/entities/customer-login-history.entity';
export default registerAs('database', (): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: [StaffOAuthChallenge,User, LoginHistory, Session,Role,Permission,UserRole,RolePermission,Category,Product,Customer,Inventory,InventoryTransaction,Order,OrderItem,Payment,Refund,StripeWebhookEvent,CustomerAccount,CustomerSession,CustomerOAuthChallenge,CustomerLoginHistory ],

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
