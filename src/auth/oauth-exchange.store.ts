import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

const CODE_TTL_MS = 60_000; // one-time OAuth exchange codes expire after 60 seconds

interface PendingExchange {
  accessToken: string;
  expiresAt: number;
}

/**
 * In-memory, single-use store for the short-lived opaque codes minted by
 * AuthController's OAuth callback handlers and redeemed exactly once by
 * POST /auth/oauth/exchange.
 *
 * Deliberately in-memory rather than persisted: this keeps the exchange
 * step fast and dependency-free for a single-instance deployment. If this
 * template is ever run as multiple horizontally-scaled instances behind a
 * load balancer, a code minted on instance A would not be visible to
 * instance B — swap this for a shared store (e.g. Redis) with the same
 * create()/consume() shape in that case.
 */
@Injectable()
export class OAuthExchangeStore {
  private readonly codes = new Map<string, PendingExchange>();

  /**
   * Mints a new one-time code bound to an already-issued access token.
   */
  create(accessToken: string): string {
    this.prune();
    const code = crypto.randomBytes(32).toString('hex');
    this.codes.set(code, { accessToken, expiresAt: Date.now() + CODE_TTL_MS });
    return code;
  }

  /**
   * Redeems a code. Always deletes it (single-use, even if expired or
   * unknown) and returns the associated access token, or null if the code
   * was invalid/expired/already used.
   */
  consume(code: string): string | null {
    const entry = this.codes.get(code);
    this.codes.delete(code);

    if (!entry || entry.expiresAt < Date.now()) {
      return null;
    }

    return entry.accessToken;
  }

  /** Opportunistic cleanup of expired-but-never-redeemed codes. */
  private prune(): void {
    const now = Date.now();
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt < now) {
        this.codes.delete(code);
      }
    }
  }
}
