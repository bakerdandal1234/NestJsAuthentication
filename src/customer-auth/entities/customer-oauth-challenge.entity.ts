import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import { CustomerAccount } from './customer-account.entity';

/**
 * Short-lived proof that a customer completed Google and the code/binding
 * exchange, but still owes a second factor. This is never a login session.
 *
 * Only the token digest is persisted; the opaque token itself travels in
 * the existing httpOnly twoFactor cookie. The secret fingerprint binds the
 * challenge to the account's current encrypted TOTP secret, so replacing
 * that secret invalidates challenges issued before the replacement.
 */
@Entity('customer_oauth_challenges')
export class CustomerOAuthChallenge {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  tokenHash: string;

  @Column({ type: 'uuid' })
  customerAccountId: string;

  @ManyToOne(() => CustomerAccount, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customerAccountId' })
  customerAccount: CustomerAccount;

  @Column({ type: 'varchar', length: 64 })
  secretFingerprint: string;

  @Index('IDX_customer_oauth_challenges_expiry')
  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'integer', default: 0 })
  attempts: number;
}
