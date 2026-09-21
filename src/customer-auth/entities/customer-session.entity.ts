import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Exclude } from 'class-transformer';
import { CustomerAccount } from './customer-account.entity';

/**
 * One refresh-token session per device/browser login for a customer.
 * Mirrors the staff `Session` entity exactly, but scoped to
 * CustomerAccount instead of User — a fully separate session store, never
 * shared with staff sessions.
 */
@Entity('customer_sessions')
export class CustomerSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => CustomerAccount, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customerAccountId' })
  customerAccount: CustomerAccount;

  @Index()
  @Column()
  customerAccountId: string;

  // Never store the raw refresh token — only its hash. @Exclude() here is
  // an intentional small improvement over the staff Session entity, which
  // does not currently exclude this equally-sensitive field.
  @Index({ unique: true })
  @Column()
  @Exclude({ toPlainOnly: true })
  refreshTokenHash: string;

  @Column({ nullable: true })
  userAgent?: string;

  @Column({ nullable: true })
  ipAddress?: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt?: Date;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt?: Date;
}
