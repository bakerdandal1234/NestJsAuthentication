import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Builds the ONE URL the Google callback is allowed to redirect to.
 *
 * Responsibility: turning configuration into a trusted absolute URL. The
 * target never comes from the request (no `redirect_uri`, no `next`, no
 * `state` payload), so there is no open-redirect surface: the origin and
 * path are fixed at boot and only query parameters we add ourselves differ.
 *
 * Config:
 *   CUSTOMER_FRONTEND_CALLBACK_URL  full absolute URL of the customer
 *                                   callback page (takes precedence)
 *   FRONTEND_URL                    fallback origin; the default path
 *                                   `/customer/oauth/callback` is appended
 */
@Injectable()
export class CustomerFrontendService {
  private readonly callbackUrl: URL;

  constructor(config: ConfigService) {
    const explicit = config.get<string>('CUSTOMER_FRONTEND_CALLBACK_URL');
    const frontendUrl = config.get<string>('FRONTEND_URL');

    const configured =
      explicit && explicit.trim().length > 0
        ? explicit.trim()
        : `${(frontendUrl ?? '').trim().replace(/\/+$/, '')}/customer/oauth/callback`;

    let parsed: URL;

    try {
      parsed = new URL(configured);
    } catch {
      throw new Error(
        'CUSTOMER_FRONTEND_CALLBACK_URL (or FRONTEND_URL) must be an absolute URL, e.g. http://localhost:5173/customer/oauth/callback',
      );
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(
        'The customer callback URL must use http or https',
      );
    }

    this.callbackUrl = parsed;
  }

  /**
   * The customer callback page URL with the given query parameters.
   * Callers only ever pass an opaque one-time `code` or an `error` keyword —
   * never an access or refresh token.
   */
  callbackUrlWith(params: Record<string, string>): string {
    const target = new URL(this.callbackUrl.toString());

    for (const [key, value] of Object.entries(params)) {
      target.searchParams.set(key, value);
    }

    return target.toString();
  }
}
