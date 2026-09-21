import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { CUSTOMER_STATE_TTL_MS } from './customer-auth.constants';

/**
 * Mints and verifies the Google `state` value for the customer flow.
 *
 * Responsibility: the state value itself (shape, signature, expiry) — not
 * the cookie it travels in (CustomerCookiesService) and not the Passport
 * plumbing (CustomerGoogleStartGuard / CustomerGoogleCallbackGuard).
 *
 * The value is `<nonce>.<expiresAt>.<HMAC(nonce.expiresAt)>`, stored in a
 * short-lived httpOnly cookie AND sent to Google. On callback both must be
 * present and byte-identical, and the signature must verify — so a state
 * value the attacker minted elsewhere, or replayed after expiry, is refused.
 */
@Injectable()
export class CustomerOAuthStateService {
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.secret = config.getOrThrow<string>('CUSTOMER_OAUTH_STATE_SECRET');

    if (Buffer.byteLength(this.secret, 'utf8') < 32) {
      throw new Error(
        'CUSTOMER_OAUTH_STATE_SECRET must contain at least 32 bytes',
      );
    }
  }

  /** Lifetime of both the state value and the cookie carrying it. */
  get ttlMs(): number {
    return CUSTOMER_STATE_TTL_MS;
  }

  issue(): string {
    const nonce = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + CUSTOMER_STATE_TTL_MS;
    const value = `${nonce}.${expiresAt}`;

    return `${value}.${this.sign(value)}`;
  }

  /**
   * True only when the state from Google's redirect and the state from our
   * own cookie are the same well-formed, correctly signed, unexpired value.
   */
  verify(queryState: unknown, cookieState: unknown): boolean {
    if (
      typeof queryState !== 'string' ||
      typeof cookieState !== 'string' ||
      queryState.length > 256 ||
      cookieState.length > 256 ||
      !this.equals(queryState, cookieState)
    ) {
      return false;
    }

    const parts = queryState.split('.');

    if (parts.length !== 3) {
      return false;
    }

    const [nonce, expiresAtText, signature] = parts;

    if (
      !/^[a-f0-9]{64}$/.test(nonce) ||
      !/^\d{13}$/.test(expiresAtText) ||
      !/^[a-f0-9]{64}$/.test(signature)
    ) {
      return false;
    }

    if (!this.equals(signature, this.sign(`${nonce}.${expiresAtText}`))) {
      return false;
    }

    const expiresAt = Number(expiresAtText);
    const now = Date.now();

    // Upper bound too: rejects a value claiming an expiry further out than
    // we would ever issue.
    return expiresAt > now && expiresAt <= now + CUSTOMER_STATE_TTL_MS;
  }

  private sign(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('hex');
  }

  private equals(first: string, second: string): boolean {
    const a = Buffer.from(first);
    const b = Buffer.from(second);

    return a.length === b.length && timingSafeEqual(a, b);
  }
}
