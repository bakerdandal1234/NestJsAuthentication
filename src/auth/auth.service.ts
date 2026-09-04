import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import * as speakeasy from 'speakeasy';
import * as qrcode from 'qrcode';
import { UsersService } from '../users/users.service';
import { MailService } from '../mail/mail.service';
import { SessionService } from '../sessions/session.service';
import { Session } from '../sessions/entities/session.entity';
import { User } from '../users/entities/user.entity';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { JwtPayload } from './strategies/jwt.strategy';

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

/**
 * Internal-only shape returned by issueTokens(). Includes the plaintext
 * refresh token's hash so callers can persist it on the Session — this
 * must never be returned from a public method / sent to the client.
 */
interface SignedTokenPair extends AuthTokens {
  refreshTokenHash: string;
}

/**
 * Minimal duration parser for simple `<number><unit>` strings (e.g. "7d",
 * "15m") used in JWT_REFRESH_EXPIRES_IN, needed to compute Session.expiresAt
 * independently of token signing. Intentionally basic - only the units
 * already used in this project's .env are supported.
 */
function parseDurationMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) {
    throw new Error(`Unsupported duration format: "${value}"`);
  }
  const amount = Number(match[1]);
  const unitMs: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return amount * unitMs[match[2]];
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
    private readonly sessionService: SessionService,
  ) {}

  // ---------------------------------------------------------------------
  // Registration & Email verification
  // ---------------------------------------------------------------------

  async register(dto: CreateUserDto): Promise<{ message: string }> {
    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    const emailVerificationToken = crypto.randomBytes(32).toString('hex');

    const user = await this.usersService.create({
      ...dto,
      password: passwordHash,
      emailVerificationToken,
      emailVerificationExpires: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
    });

    await this.mailService.sendEmailVerification(user.email, emailVerificationToken);

    return { message: 'Registration successful. Please check your email to verify your account.' };
  }

  async verifyEmail(token: string): Promise<{ message: string }> {
    const user = await this.usersService.findByEmailVerificationToken(token);

    if (!user || !user.emailVerificationExpires || user.emailVerificationExpires < new Date()) {
      throw new BadRequestException('Invalid or expired verification token');
    }

    user.isEmailVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await this.usersService.save(user);

    return { message: 'Email verified successfully' };
  }

  // ---------------------------------------------------------------------
  // Login (with account lockout + optional 2FA challenge)
  // ---------------------------------------------------------------------

  async login(
    email: string,
    password: string,
    twoFactorCode: string | undefined,
    ctx: LoginContext,
  ): Promise<AuthTokens | { twoFactorRequired: true }> {
    const user = await this.usersService.findByEmail(email);

    // Use a generic error so we don't reveal whether the email exists.
    const genericError = () => new UnauthorizedException('Invalid email or password');

    if (!user) {
      throw genericError();
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      await this.recordAttempt(user, ctx, false, 'Account locked');
      throw new ForbiddenException(
        `Account temporarily locked due to multiple failed login attempts. Try again in ${minutesLeft} minute(s).`,
      );
    }

    const passwordValid = await bcrypt.compare(password, user.password);

    if (!passwordValid) {
      await this.handleFailedLogin(user, ctx);
      throw genericError();
    }

    if (!user.isEmailVerified) {
      throw new ForbiddenException('Please verify your email address before logging in');
    }

    if (user.isTwoFactorEnabled) {
      if (!twoFactorCode) {
        // Password was correct; caller must now submit the 2FA code.
        return { twoFactorRequired: true };
      }
      const valid = speakeasy.totp.verify({
        secret: user.twoFactorSecret!,
        encoding: 'base32',
        token: twoFactorCode,
        window: 1,
      });
      if (!valid) {
        await this.recordAttempt(user, ctx, false, 'Invalid 2FA code');
        throw new UnauthorizedException('Invalid two-factor authentication code');
      }
    }

    // Successful login: reset lockout counters and issue tokens.
    user.failedLoginAttempts = 0;
    user.lockedUntil = undefined;

    // Stage 3 of Session Management: open a Session for this login and embed
    // its id (`sid`) inside the refresh token. Session.refreshTokenHash can
    // only be computed *after* the token is signed (which itself needs the
    // session id), so we create the row with a unique temporary placeholder
    // first, then overwrite it via rotateRefreshToken() once the real hash
    // is known. This uses only the existing SessionService methods.
    const refreshTtlMs = parseDurationMs(
      this.configService.get<string>('JWT_REFRESH_EXPIRES_IN')!,
    );
    const session = await this.sessionService.createSession(user.id, {
      refreshTokenHash: `pending-${crypto.randomUUID()}`,
      userAgent: ctx.userAgent,
      ipAddress: ctx.ipAddress,
      expiresAt: new Date(Date.now() + refreshTtlMs),
    });

    const { accessToken, refreshToken, refreshTokenHash } = await this.issueTokens(user, session.id);
    await this.sessionService.rotateRefreshToken(session.id, refreshTokenHash);

    await this.usersService.save(user);
    await this.recordAttempt(user, ctx, true);

    return { accessToken, refreshToken };
  }

  private async handleFailedLogin(user: User, ctx: LoginContext): Promise<void> {
    user.failedLoginAttempts += 1;

    if (user.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
      user.lockedUntil = new Date(Date.now() + LOCK_DURATION_MS);
      user.failedLoginAttempts = 0;
      await this.mailService.sendAccountLockedNotice(user.email);
    }

    await this.usersService.save(user);
    await this.recordAttempt(user, ctx, false, 'Invalid password');
  }

  private async recordAttempt(
    user: User,
    ctx: LoginContext,
    success: boolean,
    failureReason?: string,
  ): Promise<void> {
    await this.usersService.recordLoginHistory({
      userId: user.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      success,
      failureReason,
    });
  }

  // ---------------------------------------------------------------------
  // Tokens
  // ---------------------------------------------------------------------

  /**
   * bcrypt only considers the first 72 bytes of its input. Our refresh JWTs
   * share a long identical prefix across rotations of the *same* session
   * (header + sub/email/role/sid never change — only iat/exp/signature do,
   * and those land past byte 72), so bcrypt.compare() could not actually
   * tell an old, already-rotated token apart from the current one. Hashing
   * the full token with SHA-256 first collapses the *entire* string into a
   * fixed-length digest before bcrypt ever sees it, fixing that blind spot.
   */
  private hashRefreshToken(refreshToken: string): string {
    return crypto.createHash('sha256').update(refreshToken).digest('hex');
  }

  private async issueTokens(user: User, sessionId?: string): Promise<SignedTokenPair> {
    const accessPayload: JwtPayload = { sub: user.id, email: user.email, role: user.role };
    // `sid` is only embedded when a Session exists for this token pair.
    const refreshPayload: JwtPayload = sessionId
      ? { ...accessPayload, sid: sessionId }
      : accessPayload;

      

    // `expiresIn` cast to `any`: the `ms` package's typing only accepts a
    // narrow template-literal type, but our env values are validated at
    // startup (env.validation.ts) so a plain string is safe here.
    const accessToken = await this.jwtService.signAsync(accessPayload, {
      secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.configService.get<string>('JWT_ACCESS_EXPIRES_IN') as any,
    });

    const refreshToken = await this.jwtService.signAsync(refreshPayload, {
      secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') as any,
    });

    const refreshTokenHash = await bcrypt.hash(this.hashRefreshToken(refreshToken), SALT_ROUNDS);

    return { accessToken, refreshToken, refreshTokenHash };
  }

  /**
   * Shared refresh-token error, extracted so refreshTokens() and logout()
   * always return the exact same generic message (Stage 7 cleanup).
   */
  private invalidRefreshTokenError(): UnauthorizedException {
    return new UnauthorizedException('Invalid or expired refresh token');
  }

  /**
   * Verifies a refresh token's signature and expiry, shared by
   * refreshTokens() and logout() (Stage 7 cleanup — was duplicated in both).
   */
  private async verifyRefreshToken(refreshToken: string): Promise<JwtPayload> {
    try {
      return await this.jwtService.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw this.invalidRefreshTokenError();
    }
  }

  async refreshTokens(refreshToken: string): Promise<AuthTokens> {
    const payload = await this.verifyRefreshToken(refreshToken);

    // 1. Verify sub + sid are present.
    if (!payload.sid) {
      throw this.invalidRefreshTokenError();
    }

    // 2. Look up the Session by sid.
    let session: Session;
    try {
      session = await this.sessionService.findById(payload.sid);
    } catch {
      throw this.invalidRefreshTokenError();
    }

    if (session.userId !== payload.sub) {
      throw this.invalidRefreshTokenError();
    }

    // 3. Check revokedAt / expiresAt.
    if (session.revokedAt || session.expiresAt < new Date()) {
      throw this.invalidRefreshTokenError();
    }

    // 4. Check the hash.
    const matches = await bcrypt.compare(this.hashRefreshToken(refreshToken), session.refreshTokenHash);
    if (!matches) {
      // Reused or forged refresh token: revoke the session defensively.
      await this.sessionService.revokeSession(session.id);
      throw this.invalidRefreshTokenError();
    }

    // 5. Rotate: issue a new pair bound to the same session.
    const user = await this.usersService.findById(session.userId);
    const { accessToken, refreshToken: newRefreshToken, refreshTokenHash } = await this.issueTokens(
      user,
      session.id,
    );
    await this.sessionService.rotateRefreshToken(session.id, refreshTokenHash);

    return { accessToken, refreshToken: newRefreshToken };
  }

  async logout(userId: string, refreshToken: string): Promise<{ message: string }> {
    const payload = await this.verifyRefreshToken(refreshToken);

    // The refresh token must carry a sid, and must belong to the same user
    // identified by the (already-verified) access token used to reach this
    // route — this stops a user from revoking a session that isn't theirs.
    if (!payload.sid || payload.sub !== userId) {
      throw this.invalidRefreshTokenError();
    }

    // Revoke only this one session (Stage 5) — not every session for the user.
    await this.sessionService.revokeSession(payload.sid);
    return { message: 'Logged out successfully' };
  }

  // ---------------------------------------------------------------------
  // Password reset
  // ---------------------------------------------------------------------

  async forgotPassword(email: string): Promise<{ message: string }> {
    const genericResponse = {
      message: 'If an account with that email exists, a password reset link has been sent.',
    };

    const user = await this.usersService.findByEmail(email);
    if (!user) {
      // Don't reveal whether the email is registered.
      return genericResponse;
    }

    const token = crypto.randomBytes(32).toString('hex');
    user.passwordResetToken = token;
    user.passwordResetExpires = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
    await this.usersService.save(user);

    await this.mailService.sendPasswordReset(user.email, token);
    return genericResponse;
  }

  async resetPassword(token: string, newPassword: string): Promise<{ message: string }> {
    const user = await this.usersService.findByPasswordResetToken(token);

    if (!user || !user.passwordResetExpires || user.passwordResetExpires < new Date()) {
      throw new BadRequestException('Invalid or expired password reset token');
    }

    user.password = await bcrypt.hash(newPassword, SALT_ROUNDS);
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    user.failedLoginAttempts = 0;
    user.lockedUntil = undefined;

    await this.usersService.save(user);
    // Invalidate every active session as a security measure (password
    // reset should force re-authentication on every device).
    await this.sessionService.revokeAllSessions(user.id);

    return { message: 'Password reset successfully. Please log in with your new password.' };
  }

  // ---------------------------------------------------------------------
  // Two-factor authentication (TOTP / Google Authenticator)
  // ---------------------------------------------------------------------

  async generateTwoFactorSecret(userId: string): Promise<{ qrCodeDataUrl: string; secret: string }> {
    const user = await this.usersService.findById(userId);

    const secret = speakeasy.generateSecret({
      name: `MyApp (${user.email})`,
    });

    user.twoFactorSecret = secret.base32;
    await this.usersService.save(user);

    const qrCodeDataUrl = await qrcode.toDataURL(secret.otpauth_url!);
    return { qrCodeDataUrl, secret: secret.base32 };
  }

  async enableTwoFactor(userId: string, code: string): Promise<{ message: string }> {
    const user = await this.usersService.findById(userId);

    if (!user.twoFactorSecret) {
      throw new BadRequestException('Two-factor setup has not been initiated');
    }

    const valid = speakeasy.totp.verify({
      secret: user.twoFactorSecret,
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (!valid) {
      throw new BadRequestException('Invalid two-factor authentication code');
    }

    user.isTwoFactorEnabled = true;
    await this.usersService.save(user);
    return { message: 'Two-factor authentication enabled' };
  }

  async disableTwoFactor(userId: string, code: string): Promise<{ message: string }> {
    const user = await this.usersService.findById(userId);

    if (!user.isTwoFactorEnabled || !user.twoFactorSecret) {
      throw new BadRequestException('Two-factor authentication is not enabled');
    }

    const valid = speakeasy.totp.verify({
      secret: user.twoFactorSecret,
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (!valid) {
      throw new BadRequestException('Invalid two-factor authentication code');
    }

    user.isTwoFactorEnabled = false;
    user.twoFactorSecret = undefined;
    await this.usersService.save(user);
    return { message: 'Two-factor authentication disabled' };
  }

  // ---------------------------------------------------------------------
  // Login history
  // ---------------------------------------------------------------------

  async getLoginHistory(userId: string) {
    return this.usersService.getLoginHistory(userId);
  }
}
