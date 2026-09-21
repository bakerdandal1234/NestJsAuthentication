import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isUUID } from 'class-validator';

import {
  CUSTOMER_ACCESS_TTL_SECONDS,
  CUSTOMER_REFRESH_TTL_SECONDS,
} from './customer-auth.constants';

const ISSUER = 'flowdesk';
const ACCESS_AUDIENCE = 'flowdesk-customer';
const REFRESH_AUDIENCE = 'flowdesk-customer-refresh';

interface CustomerRefreshClaims {
  accountId: string;
  sessionId: string;
}

function isRefreshPayload(
  value: unknown,
): value is { sub: string; sid: string; type: string } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const payload = value as Record<string, unknown>;

  return (
    typeof payload.sub === 'string' &&
    isUUID(payload.sub) &&
    typeof payload.sid === 'string' &&
    isUUID(payload.sid) &&
    typeof payload.type === 'string'
  );
}

/**
 * Signs and verifies customer JWTs, and derives the customer CSRF token.
 *
 * Responsibility: cryptography on tokens only — no DB, no cookies, no HTTP.
 *
 * Staff isolation is enforced in the constructor rather than by convention:
 * the three customer secrets must exist, be >= 32 bytes, be distinct from
 * each other, and differ from every staff secret. A staff access token
 * therefore fails signature verification on a customer route and vice
 * versa, and the audience/type claims add a second, independent mismatch.
 */
@Injectable()
export class CustomerTokensService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly csrfSecret: string;

  constructor(
    private readonly jwtService: JwtService,
    config: ConfigService,
  ) {
    this.accessSecret = config.getOrThrow<string>('CUSTOMER_JWT_ACCESS_SECRET');
    this.refreshSecret = config.getOrThrow<string>('CUSTOMER_JWT_REFRESH_SECRET');
    this.csrfSecret = config.getOrThrow<string>('CUSTOMER_CSRF_SECRET');

    const customerSecrets = [
      this.accessSecret,
      this.refreshSecret,
      this.csrfSecret,
    ];

    if (
      customerSecrets.some((secret) => Buffer.byteLength(secret, 'utf8') < 32) ||
      new Set(customerSecrets).size !== customerSecrets.length
    ) {
      throw new Error(
        'Customer auth secrets must be distinct and at least 32 bytes each',
      );
    }

    const staffSecrets = [
      config.get<string>('JWT_ACCESS_SECRET'),
      config.get<string>('JWT_REFRESH_SECRET'),
      config.get<string>('CSRF_SECRET'),
    ];

    if (customerSecrets.some((secret) => staffSecrets.includes(secret))) {
      throw new Error(
        'Customer auth secrets must differ from staff auth secrets',
      );
    }
  }

  signAccessToken(accountId: string, sessionId: string): Promise<string> {
    return this.jwtService.signAsync(
      { sub: accountId, sid: sessionId, type: 'customer_access' },
      {
        secret: this.accessSecret,
        algorithm: 'HS256',
        issuer: ISSUER,
        audience: ACCESS_AUDIENCE,
        expiresIn: CUSTOMER_ACCESS_TTL_SECONDS,
        jwtid: randomUUID(),
      },
    );
  }

  signRefreshToken(accountId: string, sessionId: string): Promise<string> {
    return this.jwtService.signAsync(
      { sub: accountId, sid: sessionId, type: 'customer_refresh' },
      {
        secret: this.refreshSecret,
        algorithm: 'HS256',
        issuer: ISSUER,
        audience: REFRESH_AUDIENCE,
        expiresIn: CUSTOMER_REFRESH_TTL_SECONDS,
        jwtid: randomUUID(),
      },
    );
  }

  /**
   * Verifies signature, expiry, issuer, audience AND the `type` claim.
   * Throws the same generic error for every failure mode.
   */
  async verifyRefreshToken(token: string): Promise<CustomerRefreshClaims> {
    let payload: unknown;

    try {
      // `verifyAsync<T>` constrains T to `object`, so the narrowest type it
      // accepts is an index signature rather than `unknown`. The result is
      // still widened to `unknown` above and only trusted after the
      // isRefreshPayload() guard below.
      payload = await this.jwtService.verifyAsync<Record<string, unknown>>(
        token,
        {
          secret: this.refreshSecret,
          algorithms: ['HS256'],
          issuer: ISSUER,
          audience: REFRESH_AUDIENCE,
        },
      );
    } catch {
      throw this.invalidRefreshToken();
    }

    if (!isRefreshPayload(payload) || payload.type !== 'customer_refresh') {
      throw this.invalidRefreshToken();
    }

    return { accountId: payload.sub, sessionId: payload.sid };
  }

  invalidRefreshToken(): UnauthorizedException {
    return new UnauthorizedException('Invalid or expired refresh token');
  }

  /**
   * Refresh tokens are stored as a plain SHA-256 digest (not bcrypt): the
   * input is already a high-entropy signed JWT, the digest has to be
   * deterministic for the unique index on customer_sessions.refreshTokenHash,
   * and SHA-256 covers the whole string (bcrypt would only see the first 72
   * bytes, which barely change between rotations of the same session).
   */
  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Storage-free CSRF token: HMAC(sessionId, CUSTOMER_CSRF_SECRET). Nothing
   * is stored or looked up to verify it — the server recomputes it from the
   * session id inside the already-verified refresh token and compares.
   */
  computeCsrfToken(sessionId: string): string {
    return createHmac('sha256', this.csrfSecret).update(sessionId).digest('hex');
  }

  csrfMatches(sessionId: string, provided: string | undefined): boolean {
    if (!provided) {
      return false;
    }

    const expected = Buffer.from(this.computeCsrfToken(sessionId));
    const actual = Buffer.from(provided);

    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }
}
