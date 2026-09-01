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

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
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
    const tokens = await this.issueTokens(user);
    await this.usersService.save(user);
    await this.recordAttempt(user, ctx, true);

    return tokens;
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

  private async issueTokens(user: User): Promise<AuthTokens> {
    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role };

    // `expiresIn` cast to `any`: the `ms` package's typing only accepts a
    // narrow template-literal type, but our env values are validated at
    // startup (env.validation.ts) so a plain string is safe here.
    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.configService.get<string>('JWT_ACCESS_EXPIRES_IN') as any,
    });

    const refreshToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') as any,
    });

    user.currentRefreshTokenHash = await bcrypt.hash(refreshToken, SALT_ROUNDS);

    return { accessToken, refreshToken };
  }

  async refreshTokens(refreshToken: string): Promise<AuthTokens> {
    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const user = await this.usersService.findById(payload.sub);

    if (!user?.currentRefreshTokenHash) {
      throw new UnauthorizedException('Access denied');
    }

    const matches = await bcrypt.compare(refreshToken, user.currentRefreshTokenHash);
    if (!matches) {
      // Possible token theft/reuse: revoke the session defensively.
      user.currentRefreshTokenHash = undefined;
      await this.usersService.save(user);
      throw new UnauthorizedException('Access denied');
    }

    const tokens = await this.issueTokens(user);
    await this.usersService.save(user);
    return tokens;
  }

  async logout(userId: string): Promise<{ message: string }> {
    const user = await this.usersService.findById(userId);
    user.currentRefreshTokenHash = undefined;
    await this.usersService.save(user);
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
    // Invalidate any existing session as a security measure.
    user.currentRefreshTokenHash = undefined;
    user.failedLoginAttempts = 0;
    user.lockedUntil = undefined;

    await this.usersService.save(user);
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
