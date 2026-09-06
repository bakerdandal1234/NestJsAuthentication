import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import * as crypto from 'crypto';
import type { Request } from 'express';

/**
 * NOTE: superseded by the storage-free HMAC design in AuthService
 * (computeCsrfToken()/refreshTokens()) — the header is now checked
 * directly inside AuthService.refreshTokens() against a value recomputed
 * from the session id, not by comparing two cookies here. Left in place
 * unused rather than deleted; safe to remove if nothing else adopts it.
 *
 * Route-scoped double-submit CSRF check for cookie-authenticated,
 * state-changing endpoints (currently just POST /auth/refresh).
 *
 * Why only /auth/refresh needs this: every other mutating route is
 * protected by the global JwtAuthGuard, which requires a real
 * Authorization: Bearer <token> header — something a cross-site attacker
 * cannot forge, since the token lives only in the legitimate frontend's
 * JS memory. /auth/refresh is the one exception: it authenticates purely
 * via the httpOnly `refresh_token` cookie, which browsers attach to
 * requests automatically regardless of which site triggered them. Without
 * this check, a cross-site page could silently trigger token rotation
 * using a logged-in victim's cookie.
 *
 * How it works: the server hands the frontend a `csrfToken` value in the
 * JSON response body whenever it (re)issues the refresh cookie (login,
 * refresh, OAuth exchange) and simultaneously stores that same value in a
 * second, `httpOnly` `csrf_token` cookie. The frontend cannot read either
 * cookie directly (frontend and backend are different origins), but it
 * already has the value from the response body, and echoes it back as an
 * `X-CSRF-Token` header on the next refresh call. An attacker's page can
 * trigger the request (cookie attaches automatically) but has no way to
 * learn the value to also set as the header, so the comparison below fails.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const cookieToken = request.cookies?.['csrf_token'];
    const headerToken = request.headers['x-csrf-token'];

    if (!cookieToken || !headerToken || typeof headerToken !== 'string') {
      throw new ForbiddenException('Missing CSRF token');
    }

    const cookieBuffer = Buffer.from(cookieToken);
    const headerBuffer = Buffer.from(headerToken);

    // Length check first: timingSafeEqual throws (rather than returning
    // false) if the buffers differ in length.
    if (
      cookieBuffer.length !== headerBuffer.length ||
      !crypto.timingSafeEqual(cookieBuffer, headerBuffer)
    ) {
      throw new ForbiddenException('Invalid CSRF token');
    }

    return true;
  }
}
