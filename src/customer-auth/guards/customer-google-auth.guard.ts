import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request, Response } from 'express';

import { CustomerCookiesService } from '../customer-cookies.service';
import { CustomerOAuthStateService } from '../customer-oauth-state.service';

/**
 * Starts the customer Google login: mints a signed `state`, stores it in a
 * short-lived httpOnly cookie, and hands the same value to Passport so
 * Google echoes it back on the callback.
 *
 * State handling lives in CustomerOAuthStateService and cookie handling in
 * CustomerCookiesService — this guard only wires them into Passport.
 */
@Injectable()
export class CustomerGoogleStartGuard extends AuthGuard('customer-google') {
  constructor(
    private readonly cookies: CustomerCookiesService,
    private readonly state: CustomerOAuthStateService,
  ) {
    super();
  }

  getAuthenticateOptions(context: ExecutionContext) {
    const response = context.switchToHttp().getResponse<Response>();
    const state = this.state.issue();

    this.cookies.set(response, 'state', state, this.state.ttlMs);

    return { session: false, state };
  }
}

/**
 * Verifies the state round-trip BEFORE letting Passport exchange the
 * authorization code with Google. The cookie is cleared either way, so a
 * state value can only ever be used once.
 */
@Injectable()
export class CustomerGoogleCallbackGuard extends AuthGuard('customer-google') {
  constructor(
    private readonly cookies: CustomerCookiesService,
    private readonly state: CustomerOAuthStateService,
  ) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const queryState: unknown = request.query.state;
    const cookieState = this.cookies.read(request, 'state');

    this.cookies.clear(response, 'state');

    if (!this.state.verify(queryState, cookieState)) {
      throw new UnauthorizedException(
        'Invalid or expired Google login attempt. Please try again.',
      );
    }

    return super.canActivate(context);
  }

  getAuthenticateOptions() {
    return { session: false };
  }
}
