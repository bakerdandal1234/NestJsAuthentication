import {
  StaffOAuthChallengeService,
  STAFF_OAUTH_2FA_TTL_SECONDS,
} from './staff-oauth-challenge.service';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { UsersService } from '../users/users.service';
import { MailDeliveryError, MailService } from '../mail/mail.service';
import { User } from '../users/entities/user.entity';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { AuthorizationService } from '../authorization/authorization.service';
import { OAuthProfile } from './interfaces/oauth-profile.interface';
import { StaffTwoFactorService } from './staff-two-factor.service';
import { assertPasswordFitsBcrypt } from './password-limits';
import { AuthSessionService } from './auth-session.service';
import type { StaffOAuthChallenge } from './staff-oauth-challenge.entity';
import { TwoFactorCodeRejectedError } from './two-factor-step';

const SALT_ROUNDS = 12;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface LoginContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

// These IDs let the controller bind cookies and exchange codes to the authenticated session.
export interface LoginResult extends AuthTokens {
  sessionId: string;
  userId: string;
}

export interface AuthCookieSettings {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
  maxAge: number;
  /** Only set when COOKIE_DOMAIN is configured (e.g. cross-subdomain deployments). */
  domain?: string;
}

@Injectable()
export class AuthService {
  // Parameter-limit exception: Nest injects six workflow collaborators; revisit if another dependency is added.
  constructor(
    private readonly usersService: UsersService,
    private readonly authSessions: AuthSessionService,
    private readonly mailService: MailService,
    private readonly authorizationService: AuthorizationService,
    private readonly oauthChallenges: StaffOAuthChallengeService,
    private readonly twoFactor: StaffTwoFactorService,
  ) {}

  async register(dto: CreateUserDto): Promise<{ message: string }> {
    assertPasswordFitsBcrypt(dto.password);
    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    const emailVerificationToken = crypto.randomBytes(32).toString('hex');
    const user = await this.createUnverifiedAccount(
      dto,
      passwordHash,
      emailVerificationToken,
    );
    await this.authorizationService.assignRoleByName(user.id, 'user');
    await this.mailService.sendEmailVerification(
      user.email,
      emailVerificationToken,
    );
    return {
      message:
        'Registration successful. Please check your email to verify your account.',
    };
  }

  private createUnverifiedAccount(
    dto: CreateUserDto,
    passwordHash: string,
    token: string,
  ): Promise<User> {
    return this.usersService.create({
      ...dto,
      password: passwordHash,
      emailVerificationToken: token,
      emailVerificationExpires: new Date(
        Date.now() + EMAIL_VERIFICATION_TTL_MS,
      ),
    });
  }

  async verifyEmail(token: string): Promise<{ message: string }> {
    await this.usersService.consumeEmailVerificationToken(token);
    return { message: 'Email verified successfully' };
  }

  async login(
    email: string,
    password: string,
    twoFactorCode: string | undefined,
    ctx: LoginContext,
  ): Promise<LoginResult | { twoFactorRequired: true }> {
    assertPasswordFitsBcrypt(password);
    const user = await this.passwordLoginUser(email, password, ctx);
    let twoFactorStep: number | undefined;
    if (user.isTwoFactorEnabled) {
      this.assertTwoFactorAvailable(user);
      if (!twoFactorCode) {
        return { twoFactorRequired: true };
      }
      twoFactorStep = await this.verifyPasswordTwoFactor(
        user,
        twoFactorCode,
        ctx,
      );
    }
    return this.completePasswordLogin(user, ctx, twoFactorStep);
  }

  private async passwordLoginUser(
    email: string,
    password: string,
    ctx: LoginContext,
  ): Promise<User> {
    const user = await this.usersService.findByEmail(email);
    if (!user) throw this.invalidCredentialsError();
    await this.assertPasswordLoginUnlocked(user, ctx);
    await this.verifyPasswordLogin(user, password, ctx);
    if (!user.isEmailVerified) {
      throw new ForbiddenException(
        'Please verify your email address before logging in',
      );
    }
    return user;
  }

  private async assertPasswordLoginUnlocked(
    user: User,
    ctx: LoginContext,
  ): Promise<void> {
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil(
        (user.lockedUntil.getTime() - Date.now()) / 60000,
      );
      await this.recordRejectedLogin(user, ctx, 'Account locked');
      throw new ForbiddenException(
        `Account temporarily locked due to multiple failed login attempts. Try again in ${minutesLeft} minute(s).`,
      );
    }
  }

  private async verifyPasswordLogin(
    user: User,
    password: string,
    ctx: LoginContext,
  ): Promise<void> {
    if (!user.password) {
      await this.recordRejectedLogin(
        user,
        ctx,
        'No password set (OAuth-only account)',
      );
      throw this.invalidCredentialsError();
    }
    if (!(await bcrypt.compare(password, user.password))) {
      await this.recordFailedPasswordLogin(user, ctx, 'Invalid password');
      throw this.invalidCredentialsError();
    }
  }

  private async verifyPasswordTwoFactor(
    user: User,
    code: string,
    ctx: LoginContext,
  ): Promise<number> {
    const step = this.twoFactor.verifiedCodeStep(user, code);
    if (step === undefined) {
      // A correct password must not allow unlimited guesses of the second factor.
      await this.recordFailedPasswordLogin(user, ctx, 'Invalid 2FA code');
      throw new UnauthorizedException('Invalid two-factor authentication code');
    }
    return step;
  }

  private assertTwoFactorAvailable(
    user: User,
  ): asserts user is User & { twoFactorSecret: string } {
    if (!user.twoFactorSecret) {
      throw new UnauthorizedException(
        'Two-factor authentication is unavailable',
      );
    }
  }

  private invalidCredentialsError(): UnauthorizedException {
    return new UnauthorizedException('Invalid email or password');
  }

  private async completePasswordLogin(
    user: User,
    ctx: LoginContext,
    step: number | undefined,
  ): Promise<LoginResult> {
    try {
      return await this.createPasswordSession(user, ctx, step);
    } catch (error) {
      if (!(error instanceof TwoFactorCodeRejectedError)) throw error;
      await this.recordFailedPasswordLogin(user, ctx, 'Invalid 2FA code');
      throw new UnauthorizedException(error.message);
    }
  }

  private async createPasswordSession(
    user: User,
    ctx: LoginContext,
    step: number | undefined,
  ): Promise<LoginResult> {
    const sessionId = crypto.randomUUID();
    const refreshTtlMs = this.authSessions.refreshDurationMs();
    const { accessToken, refreshToken, refreshTokenHash } =
      await this.authSessions.issueTokens(user, sessionId);
    const session = {
      id: sessionId,
      refreshTokenHash,
      userAgent: ctx.userAgent,
      ipAddress: ctx.ipAddress,
      expiresAt: new Date(Date.now() + refreshTtlMs),
    };
    await this.usersService.completePasswordLogin(user, session, step);
    return { accessToken, refreshToken, sessionId, userId: user.id };
  }

  async loginWithOAuth(
    profile: OAuthProfile,
    ctx: LoginContext,
  ): Promise<
    | LoginResult
    | { twoFactorRequired: true; challenge: string; expiresIn: number }
  > {
    const user = await this.resolveOAuthUser(profile);
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new ForbiddenException('Account temporarily locked');
    }
    if (user.isTwoFactorEnabled) {
      this.assertTwoFactorAvailable(user);
      const challenge = await this.oauthChallenges.create(
        user.id,
        user.twoFactorSecret,
      );
      return {
        twoFactorRequired: true,
        challenge,
        expiresIn: STAFF_OAUTH_2FA_TTL_SECONDS,
      };
    }
    return this.authSessions.createOAuthSession(user, ctx);
  }

  async verifyOAuthTwoFactor(
    challengeToken: string | undefined,
    code: string,
    ctx: LoginContext,
  ): Promise<LoginResult> {
    const challenge = await this.oauthChallenges.attempt(challengeToken);
    const user = await this.usersService.findById(challenge.userId);
    this.assertOAuthChallengeUser(user, challenge.secretFingerprint);
    const step = this.twoFactor.verifiedCodeStep(user, code);
    if (step === undefined) {
      await this.recordRejectedLogin(
        user,
        ctx,
        'Invalid OAuth two-factor code',
      );
      throw new UnauthorizedException('Invalid two-factor authentication code');
    }
    return this.completeOAuthTwoFactor(user, ctx, challenge, step);
  }

  private async completeOAuthTwoFactor(
    user: User,
    ctx: LoginContext,
    challenge: StaffOAuthChallenge,
    step: number,
  ): Promise<LoginResult> {
    try {
      return await this.authSessions.createOAuthSession(
        user,
        ctx,
        challenge,
        step,
      );
    } catch (error) {
      if (!(error instanceof TwoFactorCodeRejectedError)) throw error;
      await this.recordRejectedLogin(
        user,
        ctx,
        'Invalid OAuth two-factor code',
      );
      throw new UnauthorizedException(error.message);
    }
  }

  private assertOAuthChallengeUser(
    user: User,
    secretFingerprint: string,
  ): void {
    if (
      !user.isTwoFactorEnabled ||
      !user.twoFactorSecret ||
      this.oauthChallenges.fingerprint(user.twoFactorSecret) !==
        secretFingerprint ||
      (user.lockedUntil && user.lockedUntil > new Date())
    ) {
      throw new UnauthorizedException(
        'Invalid or expired two-factor challenge',
      );
    }
  }

  // Trust an existing provider link; verified email is required only for a new link or account.
  private async resolveOAuthUser(profile: OAuthProfile): Promise<User> {
    const existingByProviderId =
      profile.provider === 'google'
        ? await this.usersService.findByGoogleId(profile.providerId)
        : await this.usersService.findByGithubId(profile.providerId);

    if (existingByProviderId) return existingByProviderId;

    this.assertVerifiedProviderEmail(profile);
    const existingByEmail = await this.usersService.findByEmail(profile.email);
    if (existingByEmail) {
      await this.usersService.linkOAuthAccount(
        existingByEmail.id,
        profile.provider,
        profile.providerId,
      );
      return this.usersService.findById(existingByEmail.id);
    }
    return this.createOAuthUser(profile);
  }

  private assertVerifiedProviderEmail(
    profile: OAuthProfile,
  ): asserts profile is OAuthProfile & { email: string } {
    const providerLabel = profile.provider === 'google' ? 'Google' : 'GitHub';
    if (!profile.email) {
      throw new BadRequestException(
        `${providerLabel} did not provide an email address for this account. Please make your email public/accessible with that provider and try again.`,
      );
    }

    // Checked before any lookup so an unverified address can neither create
    // nor link an account, and never reveals whether one already exists.
    if (!profile.emailVerified) {
      throw new BadRequestException(
        `${providerLabel} reports this email address as unverified. Verify it with the provider and try again.`,
      );
    }
  }

  private async createOAuthUser(
    profile: OAuthProfile & { email: string },
  ): Promise<User> {
    const newUser = await this.usersService.createOAuthUser({
      email: profile.email,
      firstName: profile.firstName,
      lastName: profile.lastName,
      isEmailVerified: profile.emailVerified,
      googleId: profile.provider === 'google' ? profile.providerId : undefined,
      githubId: profile.provider === 'github' ? profile.providerId : undefined,
    });
    await this.authorizationService.assignRoleByName(newUser.id, 'user');
    return newUser;
  }

  private async recordFailedPasswordLogin(
    user: User,
    ctx: LoginContext,
    failureReason: string,
  ): Promise<void> {
    const lockedUntil = await this.usersService.recordFailedLogin(
      {
        userId: user.id,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        failureReason,
      },
      { maxAttempts: MAX_FAILED_ATTEMPTS, durationMs: LOCK_DURATION_MS },
    );
    if (lockedUntil) {
      await this.mailService.sendAccountLockedNotice(user.email);
    }
  }

  private async recordRejectedLogin(
    user: User,
    ctx: LoginContext,
    failureReason: string,
  ): Promise<void> {
    await this.usersService.recordLoginHistory({
      userId: user.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      success: false,
      failureReason,
    });
  }

  getAuthCookieSettings(): AuthCookieSettings {
    return this.authSessions.getAuthCookieSettings();
  }

  computeCsrfToken(sessionId: string): string {
    return this.authSessions.computeCsrfToken(sessionId);
  }

  createOAuthExchangeCode(userId: string, sessionId: string): Promise<string> {
    return this.authSessions.createOAuthExchangeCode(userId, sessionId);
  }

  exchangeOAuthCode(
    code: string,
    refreshToken: string | undefined,
  ): Promise<{ accessToken: string }> {
    return this.authSessions.exchangeOAuthCode(code, refreshToken);
  }

  refreshTokens(
    refreshToken: string | undefined,
    csrfToken: string | undefined,
  ): Promise<LoginResult> {
    return this.authSessions.refreshTokens(refreshToken, csrfToken);
  }

  logout(
    userId: string,
    refreshToken: string | undefined,
  ): Promise<{ message: string }> {
    return this.authSessions.logout(userId, refreshToken);
  }

  async forgotPassword(email: string): Promise<{ message: string }> {
    const genericResponse = {
      message:
        'If an account with that email exists, check your email for password reset instructions. If no email arrives, try again later.',
    };
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      // Don't reveal whether the email is registered.
      return genericResponse;
    }
    const token = crypto.randomBytes(32).toString('hex');
    await this.usersService.storePasswordResetToken(
      user.id,
      token,
      new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    );
    await this.sendPasswordResetInstructions(user.email, token);
    return genericResponse;
  }

  private async sendPasswordResetInstructions(
    email: string,
    token: string,
  ): Promise<void> {
    // SMTP failures must not reveal which email addresses have accounts; MailService logs the delivery failure.
    try {
      await this.mailService.sendPasswordReset(email, token);
    } catch (error) {
      if (!(error instanceof MailDeliveryError)) throw error;
    }
  }

  async resetPassword(
    token: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    assertPasswordFitsBcrypt(newPassword);
    const user = await this.passwordResetUser(token);
    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await this.usersService.resetPasswordAndRevokeSessions(
      user.id,
      token,
      passwordHash,
    );
    return {
      message:
        'Password reset successfully. Please log in with your new password.',
    };
  }

  private async passwordResetUser(token: string): Promise<User> {
    const user = await this.usersService.findByPasswordResetToken(token);
    if (
      !user ||
      !user.passwordResetExpires ||
      user.passwordResetExpires.getTime() <= Date.now()
    ) {
      throw new BadRequestException('Invalid or expired password reset token');
    }
    return user;
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    assertPasswordFitsBcrypt(currentPassword);
    assertPasswordFitsBcrypt(newPassword);
    const user = await this.usersService.findById(userId);
    await this.verifyCurrentPassword(user, currentPassword);
    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await this.usersService.changePasswordAndRevokeSessions(
      user.id,
      user.password!,
      passwordHash,
    );
    return { message: 'Password changed successfully. Please log in again.' };
  }

  private async verifyCurrentPassword(
    user: User,
    currentPassword: string,
  ): Promise<void> {
    if (!user.password) {
      throw new BadRequestException(
        'This account has no password yet. Use "Forgot password" to create one.',
      );
    }

    if (!(await bcrypt.compare(currentPassword, user.password))) {
      throw new BadRequestException('Current password is incorrect');
    }
  }

  generateTwoFactorSecret(userId: string): Promise<{
    qrCodeDataUrl: string;
    secret: string;
  }> {
    return this.twoFactor.generateSetup(userId);
  }

  enableTwoFactor(userId: string, code: string): Promise<{ message: string }> {
    return this.twoFactor.enable(userId, code);
  }

  disableTwoFactor(userId: string, code: string): Promise<{ message: string }> {
    return this.twoFactor.disable(userId, code);
  }

  async getLoginHistory(userId: string) {
    return this.usersService.getLoginHistory(userId);
  }
}
