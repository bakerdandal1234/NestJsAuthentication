import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';

import {
  CUSTOMER_COOKIE,
  CUSTOMER_COOKIE_PATH,
  CUSTOMER_HTTP_ONLY_COOKIES,
  CUSTOMER_REFRESH_TTL_SECONDS,
  type CustomerCookieName,
} from './customer-auth.constants';

/**
 * The ONLY place in the customer flow that reads or writes a cookie.
 *
 * Responsibility: cookie transport only — naming, scoping, and the
 * sameSite/secure/domain policy. It knows nothing about tokens, sessions or
 * OAuth; callers hand it opaque strings.
 *
 * Every write and the matching clear() go through the same options object,
 * because browsers only honour a cookie deletion when name + path + domain
 * match the write exactly.
 */
@Injectable()
export class CustomerCookiesService {
  constructor(private readonly config: ConfigService) {}

  /**
   * Shared transport policy, driven by the same env knobs the staff flow
   * uses (COOKIE_SAME_SITE / COOKIE_DOMAIN / NODE_ENV) so a deployment is
   * configured once — but applied to the customer cookie names only.
   *
   * - sameSite: COOKIE_SAME_SITE when set, else 'none' in production (the
   *   frontend may be on a different registrable domain than the API) or
   *   'lax' locally (localhost:5173 -> localhost:3000 is same-site, since
   *   the port is not part of a "site", so 'lax' cookies are still sent).
   * - secure: mandatory whenever sameSite is 'none', and always in production.
   *
   * NOTE: COOKIE_SAME_SITE=strict will break this flow whenever the frontend
   * and the API are not same-site, because the browser then refuses to send
   * the binding cookie on the exchange request. Use 'lax' locally, 'none'
   * (over HTTPS) for a cross-site deployment.
   */
  private policy(): CookieOptions {
    const isProduction = this.config.get<string>('NODE_ENV') === 'production';
    const configured = this.config.get<string>('COOKIE_SAME_SITE');

    const sameSite: 'lax' | 'strict' | 'none' =
      configured === 'lax' || configured === 'strict' || configured === 'none'
        ? configured
        : isProduction
          ? 'none'
          : 'lax';

    return {
      sameSite,
      secure: isProduction || sameSite === 'none',
      // Omitted entirely when unset: only relevant for cross-subdomain
      // deployments (api.example.com / app.example.com -> .example.com).
      domain: this.config.get<string>('COOKIE_DOMAIN') || undefined,
    };
  }

  private optionsFor(name: CustomerCookieName): CookieOptions {
    return {
      ...this.policy(),
      httpOnly: CUSTOMER_HTTP_ONLY_COOKIES.includes(name),
      path: CUSTOMER_COOKIE_PATH[name],
    };
  }

  /** Reads a customer cookie, returning undefined for anything not a non-empty string. */
  read(req: Request, name: CustomerCookieName): string | undefined {
    const value = req.cookies?.[CUSTOMER_COOKIE[name]];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  set(
    res: Response,
    name: CustomerCookieName,
    value: string,
    maxAgeMs: number,
  ): void {
    res.cookie(CUSTOMER_COOKIE[name], value, {
      ...this.optionsFor(name),
      maxAge: maxAgeMs,
    });
  }

  clear(res: Response, name: CustomerCookieName): void {
    res.clearCookie(CUSTOMER_COOKIE[name], this.optionsFor(name));
  }

  /** Issues the refresh + CSRF pair together — they always travel and expire together. */
  setSessionCookies(
    res: Response,
    refreshToken: string,
    csrfToken: string,
  ): void {
    const maxAgeMs = CUSTOMER_REFRESH_TTL_SECONDS * 1000;
    this.set(res, 'refresh', refreshToken, maxAgeMs);
    this.set(res, 'csrf', csrfToken, maxAgeMs);
  }

  clearSessionCookies(res: Response): void {
    this.clear(res, 'refresh');
    this.clear(res, 'csrf');
  }
}
