import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  CUSTOMER_2FA_CHALLENGE_TTL_SECONDS,
  CUSTOMER_BINDING_PATTERN,
  CUSTOMER_CHALLENGE_PATTERN,
  CUSTOMER_EXCHANGE_CODE_PATTERN,
  CUSTOMER_EXCHANGE_TTL_SECONDS,
  CUSTOMER_PENDING_2FA_PREFIX,
  CUSTOMER_PENDING_EXCHANGE_PREFIX,
} from './customer-auth.constants';

export interface IssuedExchangeCode {
  /** The session row this code will become. Embedded in the code itself. */
  sessionId: string;
  /** Goes in the redirect URL. Useless on its own. */
  code: string;
  /** Goes in an httpOnly cookie. Useless on its own. */
  binding: string;
  /** Stored in customer_sessions.refreshTokenHash until redeemed. */
  pendingHash: string;
  expiresIn: number;
}

export interface IssuedChallenge {
  /** Goes in an httpOnly cookie. Proves "Google already succeeded". */
  challenge: string;
  pendingHash: string;
  expiresIn: number;
}

/**
 * Mints and validates the two short-lived, single-use handoff artifacts of
 * the customer login: the OAuth exchange code and the 2FA challenge.
 *
 * Responsibility: their format and their cryptographic binding only. It
 * never touches the database, cookies or HTTP — the caller stores
 * `pendingHash` and compares it back later, which is what makes each
 * artifact single-use (redeeming overwrites the stored hash).
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

  // -------------------------------------------------------------------
  // 2FA challenge
  // -------------------------------------------------------------------

  issueChallenge(sessionId: string): IssuedChallenge {
    const secret = randomBytes(32).toString('hex');

    return {
      challenge: `${sessionId}.${secret}`,
      pendingHash: this.challengeHashFor(secret),
      expiresIn: CUSTOMER_2FA_CHALLENGE_TTL_SECONDS,
    };
  }

  /** Splits a challenge cookie value, or null when it isn't well-formed. */
  parseChallenge(value: unknown): { sessionId: string; secret: string } | null {
    if (typeof value !== 'string' || !CUSTOMER_CHALLENGE_PATTERN.test(value)) {
      return null;
    }

    const [sessionId, secret] = value.split('.');

    return { sessionId, secret };
  }

  challengeHashFor(secret: string): string {
    return `${CUSTOMER_PENDING_2FA_PREFIX}${sha256(secret)}`;
  }

  // -------------------------------------------------------------------

  /** Constant-time comparison of a stored hash against a recomputed one. */
  matches(stored: string, expected: string): boolean {
    const a = Buffer.from(stored);
    const b = Buffer.from(expected);

    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** One generic error for every rejected code/challenge. */
  invalid(): UnauthorizedException {
    return new UnauthorizedException('Invalid or expired login code');
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
