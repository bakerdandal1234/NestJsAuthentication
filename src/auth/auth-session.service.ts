import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JsonWebTokenError, JwtService } from '@nestjs/jwt';
import type { JwtSignOptions } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import * as crypto from 'crypto';
import { SessionService } from '../sessions/session.service';
import { Session } from '../sessions/entities/session.entity';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';
import { parseTokenDurationMs } from '../config/token-duration';
import type {
  AuthCookieSettings,
  AuthTokens,
  LoginContext,
  LoginResult,
} from './auth.service';
import type { JwtPayload } from './strategies/jwt.strategy';
import type { StaffOAuthChallenge } from './staff-oauth-challenge.entity';

const OAUTH_CODE_TTL_SECONDS = 60;
const INVALID_REFRESH_TOKEN_MESSAGE = 'Invalid or expired refresh token';
const INVALID_OAUTH_CODE_MESSAGE = 'Invalid or expired code';

// The hash stays internal; HTTP responses expose only the token pair.
interface SignedTokenPair extends AuthTokens {
  refreshTokenHash: string;
}

interface OAuthExchangePayload {
  sub: string;
  sid: string;
  type: string;
}

type SessionTokenPayload = JwtPayload & { sid: string };

@Injectable()
export class AuthSessionService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly sessionService: SessionService,
    private readonly usersService: UsersService,
  ) {}

  async issueTokens(user: User, sessionId: string): Promise<SignedTokenPair> {
    const accessToken = await this.signAccessToken(user, sessionId);
    const refreshToken = await this.signSessionToken(user, sessionId, {
      secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.configService.get<string>(
        'JWT_REFRESH_EXPIRES_IN',
      ) as JwtSignOptions['expiresIn'],
    });
    return {
      accessToken,
      refreshToken,
      refreshTokenHash: this.hashToken(refreshToken),
    };
  }

  refreshDurationMs(): number {
    return parseTokenDurationMs(
      this.configService.get<string>('JWT_REFRESH_EXPIRES_IN')!,
    );
  }

  async createOAuthSession(
    user: User,
    context: LoginContext,
    challenge?: StaffOAuthChallenge,
    twoFactorStep?: number,
  ): Promise<LoginResult> {
    const sessionId = crypto.randomUUID();
    const refreshTtlMs = this.refreshDurationMs();
    const { accessToken, refreshToken, refreshTokenHash } =
      await this.issueTokens(user, sessionId);
    const session = {
      id: sessionId,
      refreshTokenHash,
      userAgent: context.userAgent,
      ipAddress: context.ipAddress,
      expiresAt: new Date(Date.now() + refreshTtlMs),
      lastUsedAt: new Date(),
    };
    await this.usersService.completeOAuthLogin(
      user,
      session,
      challenge,
      twoFactorStep,
    );
    return { accessToken, refreshToken, sessionId, userId: user.id };
  }

  getAuthCookieSettings(): AuthCookieSettings {
    const isProduction =
      this.configService.get<string>('NODE_ENV') === 'production';
    const configuredSameSite =
      this.configService.get<AuthCookieSettings['sameSite']>(
        'COOKIE_SAME_SITE',
      );
    const sameSite = configuredSameSite ?? (isProduction ? 'none' : 'lax');
    return {
      httpOnly: true,
      secure: isProduction || sameSite === 'none',
      sameSite,
      path: '/v1/auth',
      maxAge: this.refreshDurationMs(),
      domain: this.configService.get<string>('COOKIE_DOMAIN') || undefined,
    };
  }

  // Binding the HMAC to a verified session prevents forged double-submit cookies.
  computeCsrfToken(sessionId: string): string {
    return crypto
      .createHmac('sha256', this.configService.get<string>('CSRF_SECRET')!)
      .update(sessionId)
      .digest('hex');
  }

  async refreshTokens(
    refreshToken: string | undefined,
    csrfToken: string | undefined,
  ): Promise<LoginResult> {
    if (!refreshToken) throw this.invalidRefreshTokenError();
    const payload = await this.verifyRefreshToken(refreshToken);
    // Reject cross-site requests before any database access.
    this.assertCsrfToken(payload.sid, csrfToken);
    const session = await this.refreshSession(payload.sid, payload.sub);
    return this.rotateSession(session, refreshToken);
  }

  async logout(
    userId: string,
    refreshToken: string | undefined,
  ): Promise<{ message: string }> {
    if (!refreshToken) throw this.invalidRefreshTokenError();
    const payload = await this.verifyRefreshToken(refreshToken);
    if (payload.sub !== userId) throw this.invalidRefreshTokenError();
    await this.sessionService.revokeSession(payload.sid);
    return { message: 'Logged out successfully' };
  }

  async createOAuthExchangeCode(
    userId: string,
    sessionId: string,
  ): Promise<string> {
    const code = await this.signOAuthExchangeCode(userId, sessionId);
    await this.sessionService.storeOAuthExchangeCode(
      sessionId,
      userId,
      this.hashToken(code),
      new Date(Date.now() + OAUTH_CODE_TTL_SECONDS * 1000),
    );
    return code;
  }

  private signOAuthExchangeCode(
    userId: string,
    sessionId: string,
  ): Promise<string> {
    return this.jwtService.signAsync(
      {
        sub: userId,
        sid: sessionId,
        type: 'oauth_exchange',
        jti: crypto.randomUUID(),
      },
      {
        secret: this.configService.get<string>('OAUTH_CODE_SECRET'),
        expiresIn: `${OAUTH_CODE_TTL_SECONDS}s`,
      },
    );
  }

  async exchangeOAuthCode(
    code: string,
    refreshToken: string | undefined,
  ): Promise<{ accessToken: string }> {
    if (typeof refreshToken !== 'string' || !refreshToken) {
      throw new UnauthorizedException(INVALID_OAUTH_CODE_MESSAGE);
    }
    const payload = await this.verifyOAuthExchangeCode(code);
    await this.sessionService.requireActiveSession(payload.sid, payload.sub);
    const user = await this.oauthExchangeUser(payload.sub);
    const accessToken = await this.signAccessToken(user, payload.sid);
    // Sign before consumption so signing failures leave the code available for retry.
    await this.sessionService.consumeOAuthExchangeCode({
      sessionId: payload.sid,
      userId: payload.sub,
      codeHash: this.hashToken(code),
      refreshTokenHash: this.hashToken(refreshToken),
    });
    return { accessToken };
  }

  private signAccessToken(user: User, sessionId: string): Promise<string> {
    return this.signSessionToken(user, sessionId, {
      secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: this.configService.get<string>(
        'JWT_ACCESS_EXPIRES_IN',
      ) as JwtSignOptions['expiresIn'],
    });
  }

  private signSessionToken(
    user: User,
    sessionId: string,
    options: JwtSignOptions,
  ): Promise<string> {
    // A nonce prevents identical tokens when a session issues twice within the same second.
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      sid: sessionId,
      jti: crypto.randomUUID(),
    };
    return this.jwtService.signAsync(payload, options);
  }

  private hashToken(token: string): string {
    // Deterministic hashes allow the database to compare and rotate high-entropy JWTs atomically.
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private assertCsrfToken(
    sessionId: string,
    provided: string | undefined,
  ): void {
    const expected = Buffer.from(this.computeCsrfToken(sessionId));
    const candidate = provided ? Buffer.from(provided) : undefined;
    if (
      !candidate ||
      expected.length !== candidate.length ||
      !crypto.timingSafeEqual(expected, candidate)
    ) {
      throw new ForbiddenException('Invalid or missing CSRF token');
    }
  }

  private async refreshSession(
    sessionId: string,
    userId: string,
  ): Promise<Session> {
    try {
      return await this.sessionService.requireActiveSession(sessionId, userId);
    } catch (error) {
      if (!(error instanceof UnauthorizedException)) throw error;
      throw this.invalidRefreshTokenError();
    }
  }

  private async rotateSession(
    session: Session,
    refreshToken: string,
  ): Promise<LoginResult> {
    const user = await this.usersService.findById(session.userId);
    const issuedTokens = await this.issueTokens(user, session.id);
    const rotated = await this.sessionService.rotateRefreshTokenIfMatches(
      session.id,
      this.hashToken(refreshToken),
      issuedTokens.refreshTokenHash,
    );
    if (!rotated) {
      // Preserve session revocation after a reused token or a lost concurrent rotation.
      await this.sessionService.revokeSession(session.id);
      throw this.invalidRefreshTokenError();
    }
    return {
      accessToken: issuedTokens.accessToken,
      refreshToken: issuedTokens.refreshToken,
      sessionId: session.id,
      userId: user.id,
    };
  }

  private async verifyRefreshToken(
    refreshToken: string,
  ): Promise<SessionTokenPayload> {
    const payload = await this.verifySignedToken<SessionTokenPayload>(
      refreshToken,
      'JWT_REFRESH_SECRET',
      INVALID_REFRESH_TOKEN_MESSAGE,
    );
    if (
      !payload ||
      typeof payload.sub !== 'string' ||
      !isUUID(payload.sub) ||
      typeof payload.sid !== 'string' ||
      !isUUID(payload.sid)
    ) {
      throw this.invalidRefreshTokenError();
    }
    return payload;
  }

  private async verifyOAuthExchangeCode(
    code: string,
  ): Promise<OAuthExchangePayload> {
    const payload = await this.verifySignedToken<OAuthExchangePayload>(
      code,
      'OAUTH_CODE_SECRET',
      INVALID_OAUTH_CODE_MESSAGE,
    );
    if (
      !payload ||
      payload.type !== 'oauth_exchange' ||
      typeof payload.sub !== 'string' ||
      typeof payload.sid !== 'string'
    ) {
      throw new UnauthorizedException(INVALID_OAUTH_CODE_MESSAGE);
    }
    return payload;
  }

  private async verifySignedToken<Payload extends object>(
    token: string,
    secretVariable: 'JWT_REFRESH_SECRET' | 'OAUTH_CODE_SECRET',
    invalidMessage: string,
  ): Promise<Payload> {
    try {
      return await this.jwtService.verifyAsync<Payload>(token, {
        secret: this.configService.get<string>(secretVariable),
        algorithms: ['HS256'],
      });
    } catch (error) {
      if (!(error instanceof JsonWebTokenError)) throw error;
      throw new UnauthorizedException(invalidMessage);
    }
  }

  private async oauthExchangeUser(userId: string): Promise<User> {
    try {
      return await this.usersService.findById(userId);
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
      throw new UnauthorizedException(INVALID_OAUTH_CODE_MESSAGE);
    }
  }

  private invalidRefreshTokenError(): UnauthorizedException {
    return new UnauthorizedException(INVALID_REFRESH_TOKEN_MESSAGE);
  }
}
