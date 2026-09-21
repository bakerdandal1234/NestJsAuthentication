import {
  ArgumentsHost,
  Catch,
  ConflictException,
  ExceptionFilter,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';

import { CustomerCookiesService } from '../customer-cookies.service';
import { CustomerFrontendService } from '../customer-frontend.service';

/**
 * Applied to the Google callback route only.
 *
 * The callback is a browser top-level navigation, so a failure must never
 * render the API's JSON error body at the customer — they would be stranded
 * on an API URL showing `{"statusCode":403,...}`. Instead we redirect to the
 * customer callback page with a short, opaque error keyword the frontend
 * maps to its own copy.
 *
 * Deliberately no message pass-through: the keyword set is closed, so an
 * internal message can never end up in a URL, browser history or a Referer
 * header.
 */
@Injectable()
@Catch()
export class CustomerOAuthRedirectFilter implements ExceptionFilter {
  private readonly logger = new Logger(CustomerOAuthRedirectFilter.name);

  constructor(
    private readonly cookies: CustomerCookiesService,
    private readonly frontend: CustomerFrontendService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    // Log the class/status only — never the payload, and never any secret.
    this.logger.warn(
      `Customer Google callback failed: ${
        exception instanceof HttpException
          ? `${exception.constructor.name} (${exception.getStatus()})`
          : 'UnexpectedError'
      }`,
    );

    // A half-finished attempt must not leave a stale binding cookie behind.
    this.cookies.clear(response, 'binding');
    this.cookies.clear(response, 'twoFactor');

    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.redirect(
      this.frontend.callbackUrlWith({ error: errorKeyword(exception) }),
    );
  }
}

function errorKeyword(exception: unknown): string {
  if (exception instanceof ConflictException) {
    // An unlinked Customer record already uses this email — never linked
    // automatically just because the addresses match.
    return 'email_in_use';
  }

  if (exception instanceof ForbiddenException) {
    // Locked account, or an email we do not treat as verified.
    return 'account_unavailable';
  }

  if (exception instanceof UnauthorizedException) {
    // Bad/expired state, or Google did not report a verified email.
    return 'google_verification_failed';
  }

  return 'login_failed';
}
