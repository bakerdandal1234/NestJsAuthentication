import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  CUSTOMER_BINDING_PATTERN,
  CUSTOMER_EXCHANGE_CODE_PATTERN,
  CUSTOMER_EXCHANGE_TTL_SECONDS,
  CUSTOMER_PENDING_EXCHANGE_PREFIX,
} from './customer-auth.constants';

export interface IssuedExchangeCode {
  /** The exchange placeholder id. Embedded in the code itself. */
  sessionId: string;
  /** Goes in the redirect URL. Useless on its own. */
  code: string;
  /** Goes in an httpOnly cookie. Useless on its own. */
  binding: string;
  /** Stored in customer_sessions.refreshTokenHash until redeemed. */
  pendingHash: string;
  expiresIn: number;
}

/**
 * Mints and validates the short-lived, single-use OAuth code/binding pair.
 * The later 2FA handoff is owned by CustomerOAuthChallengeService.
 *
 * Responsibility: their format and their cryptographic binding only. It
 * never touches the database, cookies or HTTP — the caller stores
 * `pendingHash` and compares it back later, which is what makes each
 * artifact single-use (redeeming replaces the hash or revokes the row).
 *
 * The split-secret design is the point: the code travels in the URL, the
 * binding travels in an httpOnly cookie, and the stored hash only matches
 * when BOTH halves are presented together. A leaked redirect URL (history,
 * logs, a shared link) is therefore not enough to log in.
 */
@Injectable()
export class CustomerExchangeService {
  issueCode(): IssuedExchangeCode {
    const sessionId = randomUUID();
    const code = `${sessionId}.${randomBytes(32).toString('hex')}`;
    const binding = randomBytes(32).toString('hex');

    return {
      sessionId,
      code,
      binding,
      pendingHash: this.pendingHashFor(code, binding),
      expiresIn: CUSTOMER_EXCHANGE_TTL_SECONDS,
    };
  }

  isCode(value: unknown): value is string {
    return typeof value === 'string' && CUSTOMER_EXCHANGE_CODE_PATTERN.test(value);
  }

  isBinding(value: unknown): value is string {
    return typeof value === 'string' && CUSTOMER_BINDING_PATTERN.test(value);
  }

  sessionIdOf(code: string): string {
    return code.split('.')[0];
  }

  pendingHashFor(code: string, binding: string): string {
    return `${CUSTOMER_PENDING_EXCHANGE_PREFIX}${sha256(`${code}:${binding}`)}`;
  }

  /** Constant-time comparison of a stored hash against a recomputed one. */
  matches(stored: string, expected: string): boolean {
    const a = Buffer.from(stored);
    const b = Buffer.from(expected);

    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** One generic error for every rejected exchange code. */
  invalid(): UnauthorizedException {
    return new UnauthorizedException('Invalid or expired login code');
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
