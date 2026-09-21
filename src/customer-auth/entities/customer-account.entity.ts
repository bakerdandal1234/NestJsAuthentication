import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Exclude } from 'class-transformer';
import { Customer } from '../../customers/entities/customer.entity';

/**
 * The AUTH identity for a customer logging into their own account —
 * separate from `Customer` (which is pure business/contact data used by
 * Orders). A Customer has zero or one CustomerAccount; this is NEVER
 * linked to the staff `User` entity in any way (separate identity systems
 * by design — see the Task A design discussion).
 *
 * Google-only login for the MVP: there is no password, no password-reset
 * token, and no email-verification token here at all — email trust comes
 * from Google's own verified profile data once the OAuth flow is built
 * (Task B/C), not from a local verification link.
 */
@Entity('customer_accounts')
export class CustomerAccount {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Owning side of a strict 1:1 with Customer (required + unique => at
  // most one account per customer, and every account must belong to one).
  // CASCADE (unlike the RESTRICT used everywhere else in this project):
  // this is a pure ownership relation — an account has no meaning without
  // its Customer, unlike e.g. Product->Category which references an
  // independent business entity.
  @OneToOne(() => Customer, (customer) => customer.account, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'customerId' })
  customer: Customer;

  @Index({ unique: true })
  @Column()
  customerId: string;

  // Required AND unique: unlike User.googleId (optional, since User also
  // supports password login), every CustomerAccount by definition has a
  // Google identity — there is no other way to create one.
  @Index({ unique: true })
  @Column()
  googleId: string;

  // Copied from Google's profile for display/reference only. This is NOT
  // the identity key (googleId is) — deliberately not unique, so it can
  // never conflict with itself if Google's own email for an account changes.
  @Column()
  email: string;

  // Set from Google's own `email_verified` claim during login (Task B/C).
  // No local verification token exists for this account.
  @Column({ default: false })
  isEmailVerified: boolean;

  // --- 2FA (kept even with Google login — see Task A note) ---
  @Column({ nullable: true })
  @Exclude({ toPlainOnly: true })
  twoFactorSecret?: string;

  @Column({ default: false })
  isTwoFactorEnabled: boolean;

  // --- Local verification lockout ---
  // Scoped to LOCAL verification attempts (e.g. a wrong 2FA code), NOT
  // failed Google sign-ins — Google itself is the authority on whether a
  // sign-in attempt succeeded, so there is nothing for us to count there.
  @Column({ default: 0 })
  @Exclude({ toPlainOnly: true })
  failedLoginAttempts: number;

  @Column({ type: 'timestamptz', nullable: true })
  @Exclude({ toPlainOnly: true })
  lockedUntil?: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
