import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Exclude } from 'class-transformer';
import { Role } from '../../common/enums/role.enum';
import { LoginHistory } from './login-history.entity';
import { Session } from '../../sessions/entities/session.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column()
  email: string;

  @Column()
  @Exclude({ toPlainOnly: true })
  password: string;

  @Column({ nullable: true })
  firstName?: string;

  @Column({ nullable: true })
  lastName?: string;

  @Column({ type: 'enum', enum: Role, default: Role.USER })
  role: Role;

  // --- Email verification ---
  @Column({ default: false })
  isEmailVerified: boolean;

  @Column({ nullable: true })
  @Exclude({ toPlainOnly: true })
  emailVerificationToken?: string;

  @Column({ type: 'timestamptz', nullable: true })
  @Exclude({ toPlainOnly: true })
  emailVerificationExpires?: Date;

  // --- Password reset ---
  @Column({ nullable: true })
  @Exclude({ toPlainOnly: true })
  passwordResetToken?: string;

  @Column({ type: 'timestamptz', nullable: true })
  @Exclude({ toPlainOnly: true })
  passwordResetExpires?: Date;

  // --- 2FA (TOTP via Google Authenticator) ---
  @Column({ nullable: true })
  @Exclude({ toPlainOnly: true })
  twoFactorSecret?: string;

  @Column({ default: false })
  isTwoFactorEnabled: boolean;

  // --- Account lockout ---
  @Column({ default: 0 })
  @Exclude({ toPlainOnly: true })
  failedLoginAttempts: number;

  @Column({ type: 'timestamptz', nullable: true })
  @Exclude({ toPlainOnly: true })
  lockedUntil?: Date;

  
  @OneToMany(() => LoginHistory, (loginHistory) => loginHistory.user)
  loginHistory: LoginHistory[];

  @OneToMany(() => Session, (session) => session.user)
  sessions: Session[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
