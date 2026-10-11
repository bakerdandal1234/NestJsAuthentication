import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { LoginHistory } from './entities/login-history.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { Session } from '../sessions/entities/session.entity';
import {
  StaffOAuthChallenge,
  STAFF_OAUTH_2FA_MAX_ATTEMPTS,
} from '../auth/staff-oauth-challenge.entity';
import type { OAuthProfile } from '../auth/interfaces/oauth-profile.interface';
import {
  consumeTwoFactorStep,
  TwoFactorCodeRejectedError,
} from '../auth/two-factor-step';

const OAUTH_LINK_CONFLICT_MESSAGE =
  'OAuth identity conflicts with an existing account link';
const INVALID_VERIFICATION_TOKEN_MESSAGE =
  'Invalid or expired verification token';

type PasswordLoginSession = Pick<
  Session,
  'id' | 'refreshTokenHash' | 'expiresAt' | 'ipAddress' | 'userAgent'
>;
type OAuthLoginSession = PasswordLoginSession & Pick<Session, 'lastUsedAt'>;
type OAuthLoginChallenge = Pick<
  StaffOAuthChallenge,
  'tokenHash' | 'secretFingerprint'
>;
type FailedLoginEntry = Pick<
  LoginHistory,
  'userId' | 'ipAddress' | 'userAgent' | 'failureReason'
>;
interface LockoutPolicy {
  maxAttempts: number;
  durationMs: number;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(LoginHistory)
    private readonly loginHistoryRepository: Repository<LoginHistory>,
  ) {}

  async create(createUserDto: Partial<User> & CreateUserDto): Promise<User> {
    const existing = await this.findByEmail(createUserDto.email);
    if (existing) {
      throw new ConflictException(this.accountConflictMessage(existing));
    }
    const user = this.usersRepository.create(createUserDto);
    return this.usersRepository.save(user);
  }

  findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { email } });
  }

  findByGoogleId(googleId: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { googleId } });
  }

  findByGithubId(githubId: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { githubId } });
  }

  /**
   * Creates a brand-new OAuth-only user (no local password). Kept separate
   * from create() rather than widening it, since create() intentionally
   * requires the full CreateUserDto (password + validation) used by
   * /auth/register — OAuth signups never go through that DTO.
   */
  async createOAuthUser(data: {
    email: string;
    firstName?: string;
    lastName?: string;
    isEmailVerified: boolean;
    googleId?: string;
    githubId?: string;
  }): Promise<User> {
    const existing = await this.findByEmail(data.email);
    if (existing) {
      throw new ConflictException(this.accountConflictMessage(existing));
    }
    const user = this.usersRepository.create(data);
    return this.usersRepository.save(user);
  }

  async findById(id: string): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async findByIdWithAuthorization(id: string): Promise<User> {
    const user = await this.usersRepository.findOne({
      where: { id },
      relations: {
        userRoles: {
          role: {
            rolePermissions: {
              permission: true,
            },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async consumeEmailVerificationToken(token: string): Promise<void> {
    await this.usersRepository.manager.transaction(async (transaction) => {
      const user = await transaction.getRepository(User).findOne({
        select: { id: true },
        where: { emailVerificationToken: token },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user)
        throw new BadRequestException(INVALID_VERIFICATION_TOKEN_MESSAGE);
      await this.verifyEmailWithToken(transaction, user.id, token);
    });
  }

  private async verifyEmailWithToken(
    transaction: EntityManager,
    userId: string,
    token: string,
  ): Promise<void> {
    const verifiedUsers = await transaction
      .getRepository(User)
      .createQueryBuilder()
      .update(User)
      .set({
        isEmailVerified: true,
        emailVerificationToken: () => 'NULL',
        emailVerificationExpires: () => 'NULL',
      })
      .where('id = :userId', { userId })
      .andWhere('"emailVerificationToken" = :token', { token })
      .andWhere('"emailVerificationExpires" > clock_timestamp()')
      .execute();
    if (verifiedUsers.affected !== 1) {
      throw new BadRequestException(INVALID_VERIFICATION_TOKEN_MESSAGE);
    }
  }

  async storePasswordResetToken(
    userId: string,
    token: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.usersRepository.update(
      { id: userId },
      {
        passwordResetToken: token,
        passwordResetExpires: expiresAt,
      },
    );
  }

  async linkOAuthAccount(
    userId: string,
    provider: OAuthProfile['provider'],
    providerId: string,
  ): Promise<void> {
    const providerColumn = provider === 'google' ? 'googleId' : 'githubId';
    try {
      await this.updateOAuthLink(userId, providerColumn, providerId);
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        'code' in error.driverError &&
        error.driverError.code === '23505'
      ) {
        throw new ConflictException(OAUTH_LINK_CONFLICT_MESSAGE);
      }
      throw error;
    }
  }

  private async updateOAuthLink(
    userId: string,
    providerColumn: 'googleId' | 'githubId',
    providerId: string,
  ): Promise<void> {
    // The comparison belongs in the UPDATE so concurrent identities cannot replace each other.
    const linkedUsers = await this.usersRepository
      .createQueryBuilder()
      .update(User)
      .set({ [providerColumn]: providerId })
      .where('id = :userId', { userId })
      .andWhere(
        `("${providerColumn}" IS NULL OR "${providerColumn}" = :providerId)`,
        { providerId },
      )
      .execute();
    if (linkedUsers.affected !== 1) {
      throw new ConflictException(OAUTH_LINK_CONFLICT_MESSAGE);
    }
  }

  findByPasswordResetToken(token: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { passwordResetToken: token },
    });
  }

  async resetPasswordAndRevokeSessions(
    userId: string,
    token: string,
    passwordHash: string,
  ): Promise<void> {
    await this.usersRepository.manager.transaction(async (transaction) => {
      // Waiting for the lock first prevents accepting a token that expires during that wait.
      await transaction.getRepository(User).findOne({
        select: { id: true },
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      await this.consumePasswordResetToken(
        transaction,
        userId,
        token,
        passwordHash,
      );
      await transaction
        .getRepository(Session)
        .update({ userId }, { revokedAt: new Date() });
    });
  }

  async changePasswordAndRevokeSessions(
    userId: string,
    expectedHash: string,
    passwordHash: string,
  ): Promise<void> {
    await this.usersRepository.manager.transaction(async (transaction) => {
      const changedUsers = await transaction
        .createQueryBuilder()
        .update(User)
        .set(this.passwordChangeFields(passwordHash))
        .where('id = :userId', { userId })
        .andWhere('password = :expectedHash', { expectedHash })
        .execute();
      if (changedUsers.affected !== 1) {
        throw new BadRequestException('Current password is incorrect');
      }
      await transaction
        .getRepository(Session)
        .update({ userId }, { revokedAt: new Date() });
    });
  }

  async completePasswordLogin(
    user: User,
    session: PasswordLoginSession,
    twoFactorStep?: number,
  ): Promise<void> {
    await this.usersRepository.manager.transaction(async (transaction) => {
      await this.resetLockoutForPasswordLogin(transaction, user);
      await this.consumeLoginTwoFactorStep(transaction, user, twoFactorStep);
      await this.persistSuccessfulLogin(transaction, user.id, session);
    });
  }

  async completeOAuthLogin(
    user: User,
    session: OAuthLoginSession,
    challenge?: OAuthLoginChallenge,
    twoFactorStep?: number,
  ): Promise<void> {
    await this.usersRepository.manager.transaction(async (transaction) => {
      await this.assertOAuthLoginAllowed(transaction, user, challenge);
      if (challenge) {
        await transaction.getRepository(StaffOAuthChallenge).findOne({
          select: { tokenHash: true },
          where: { tokenHash: challenge.tokenHash },
          lock: { mode: 'pessimistic_write' },
        });
        await this.consumeOAuthLoginChallenge(transaction, user.id, challenge);
      }
      await this.consumeLoginTwoFactorStep(transaction, user, twoFactorStep);
      await this.persistSuccessfulLogin(transaction, user.id, session);
    });
  }

  private async consumeLoginTwoFactorStep(
    transaction: EntityManager,
    user: User,
    step: number | undefined,
  ): Promise<void> {
    if (!user.isTwoFactorEnabled) return;
    if (step === undefined) throw new TwoFactorCodeRejectedError();
    await consumeTwoFactorStep(transaction, user, step);
  }

  private async persistSuccessfulLogin(
    transaction: EntityManager,
    userId: string,
    session: PasswordLoginSession,
  ): Promise<void> {
    await transaction.getRepository(Session).insert({ ...session, userId });
    await transaction.getRepository(LoginHistory).insert({
      userId,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      success: true,
    });
  }

  private async assertOAuthLoginAllowed(
    transaction: EntityManager,
    user: User,
    challenge?: OAuthLoginChallenge,
  ): Promise<void> {
    // Serialize with password, lockout and 2FA changes until the session and audit commit.
    const currentUser = await transaction.getRepository(User).findOne({
      where: { id: user.id },
      lock: { mode: 'pessimistic_write' },
    });
    if (
      !currentUser ||
      !this.oauthSnapshotMatches(currentUser, user) ||
      user.isTwoFactorEnabled !== Boolean(challenge)
    ) {
      throw this.invalidOAuthLoginError(challenge);
    }
    this.assertOAuthLoginUnlocked(currentUser, challenge);
  }

  private oauthSnapshotMatches(currentUser: User, snapshot: User): boolean {
    return (
      currentUser.isTwoFactorEnabled === snapshot.isTwoFactorEnabled &&
      (currentUser.twoFactorSecret ?? null) ===
        (snapshot.twoFactorSecret ?? null)
    );
  }

  private assertOAuthLoginUnlocked(
    user: User,
    challenge?: OAuthLoginChallenge,
  ): void {
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      if (challenge) throw this.invalidOAuthLoginError(challenge);
      throw new ForbiddenException('Account temporarily locked');
    }
  }

  private invalidOAuthLoginError(
    challenge?: OAuthLoginChallenge,
  ): UnauthorizedException {
    return new UnauthorizedException(
      challenge
        ? 'Invalid or expired two-factor challenge'
        : 'Invalid or expired OAuth login',
    );
  }

  private async consumeOAuthLoginChallenge(
    transaction: EntityManager,
    userId: string,
    challenge: OAuthLoginChallenge,
  ): Promise<void> {
    // Both locks are held, so expiry is checked after the user and challenge waits.
    const consumedChallenge = await transaction
      .createQueryBuilder()
      .delete()
      .from(StaffOAuthChallenge)
      .where('"tokenHash" = :tokenHash', challenge)
      .andWhere('"userId" = :userId', { userId })
      .andWhere('"secretFingerprint" = :secretFingerprint')
      .andWhere('"expiresAt" > clock_timestamp()')
      .andWhere('"attempts" BETWEEN 1 AND :maxAttempts', {
        maxAttempts: STAFF_OAUTH_2FA_MAX_ATTEMPTS,
      })
      .execute();
    if (consumedChallenge.affected !== 1)
      throw this.invalidOAuthLoginError(challenge);
  }

  async recordFailedLogin(
    entry: FailedLoginEntry,
    policy: LockoutPolicy,
  ): Promise<Date | null> {
    // Return the committed lock transition to avoid duplicate notices; use an outbox if delivery must become transactional.
    return this.usersRepository.manager.transaction(async (transaction) => {
      const lockedUntil = await this.incrementFailedLogin(
        transaction,
        entry.userId,
        policy,
      );
      await transaction
        .getRepository(LoginHistory)
        .insert({ ...entry, success: false });
      return lockedUntil;
    });
  }

  async recordLoginHistory(entry: Partial<LoginHistory>): Promise<void> {
    const record = this.loginHistoryRepository.create(entry);
    await this.loginHistoryRepository.save(record);
  }

  async getLoginHistory(userId: string, limit = 20): Promise<LoginHistory[]> {
    return this.loginHistoryRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  private async consumePasswordResetToken(
    transaction: EntityManager,
    userId: string,
    token: string,
    passwordHash: string,
  ): Promise<void> {
    // Recheck in the UPDATE: a concurrent request may consume, replace or expire the token after lookup.
    const updatedUsers = await transaction
      .createQueryBuilder()
      .update(User)
      .set(this.passwordChangeFields(passwordHash))
      .where('id = :userId', { userId })
      .andWhere('"passwordResetToken" = :token', { token })
      .andWhere('"passwordResetExpires" > clock_timestamp()')
      .execute();
    if (updatedUsers.affected !== 1) {
      throw new BadRequestException('Invalid or expired password reset token');
    }
  }

  private passwordChangeFields(passwordHash: string) {
    return {
      password: passwordHash,
      failedLoginAttempts: 0,
      passwordResetToken: () => 'NULL',
      passwordResetExpires: () => 'NULL',
      lockedUntil: () => 'NULL',
    };
  }

  private async resetLockoutForPasswordLogin(
    transaction: EntityManager,
    user: User,
  ): Promise<void> {
    // Recheck credentials under the same row lock used by password changes, before inserting the session.
    const authenticatedUsers = await transaction
      .createQueryBuilder()
      .update(User)
      .set({ failedLoginAttempts: 0, lockedUntil: () => 'NULL' })
      .where('id = :userId', { userId: user.id })
      .andWhere('password = :password', { password: user.password })
      .andWhere('"isEmailVerified" = TRUE')
      .andWhere('"isTwoFactorEnabled" = :enabled', {
        enabled: user.isTwoFactorEnabled,
      })
      .andWhere('"twoFactorSecret" IS NOT DISTINCT FROM :secret', {
        secret: user.twoFactorSecret ?? null,
      })
      .andWhere('("lockedUntil" IS NULL OR "lockedUntil" <= clock_timestamp())')
      .execute();
    if (authenticatedUsers.affected !== 1) {
      throw new UnauthorizedException('Invalid email or password');
    }
  }

  private async incrementFailedLogin(
    transaction: EntityManager,
    userId: string,
    policy: LockoutPolicy,
  ): Promise<Date | null> {
    const updatedUsers = await transaction
      .createQueryBuilder()
      .update(User)
      .set({
        failedLoginAttempts: () =>
          'CASE WHEN "failedLoginAttempts" + 1 >= :maxAttempts THEN 0 ELSE "failedLoginAttempts" + 1 END',
        lockedUntil: () =>
          'CASE WHEN "failedLoginAttempts" + 1 >= :maxAttempts THEN clock_timestamp() + (:durationMs * INTERVAL \'1 millisecond\') ELSE NULL END',
      })
      .where('id = :userId', { userId })
      .andWhere('("lockedUntil" IS NULL OR "lockedUntil" <= clock_timestamp())')
      .setParameters(policy)
      .returning(['lockedUntil'])
      .execute();
    return updatedUsers.raw[0]?.lockedUntil ?? null;
  }

  /**
   * Tailors the "email already exists" conflict message to how the
   * existing account was actually created, so the caller knows what to
   * do next (log in with the linked provider, or set a local password)
   * instead of hitting an unexplained dead end.
   */
  private accountConflictMessage(existing: User): string {
    if (existing.googleId) {
      return 'An account with this email already exists via Google sign-in. Log in with Google, or use "Forgot Password" to set a local password for this account.';
    }
    if (existing.githubId) {
      return 'An account with this email already exists via GitHub sign-in. Log in with GitHub, or use "Forgot Password" to set a local password for this account.';
    }
    return 'An account with this email already exists.';
  }
}
