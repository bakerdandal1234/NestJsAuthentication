import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CustomerAccount } from './customer-account.entity';

/**
 * Mirrors the staff `LoginHistory` entity exactly, scoped to
 * CustomerAccount. Same composite index for the same reason: the only
 * real query is "recent login attempts for this account, newest first".
 */
@Entity('customer_login_history')
@Index('idx_customer_login_history_account_created_at', ['customerAccountId', 'createdAt'])
export class CustomerLoginHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => CustomerAccount, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customerAccountId' })
  customerAccount: CustomerAccount;

  @Column()
  customerAccountId: string;

  @Column({ nullable: true })
  ipAddress?: string;

  @Column({ nullable: true })
  userAgent?: string;

  @Column({ default: true })
  success: boolean;

  @Column({ nullable: true })
  failureReason?: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
