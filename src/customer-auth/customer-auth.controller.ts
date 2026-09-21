import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { Public } from '../common/decorators/public.decorator';
import { CustomerAuthService } from './customer-auth.service';
import { CustomerCookiesService } from './customer-cookies.service';
import { CustomerFrontendService } from './customer-frontend.service';
import { CustomerOAuthExchangeDto } from './dto/customer-oauth-exchange.dto';
import { CustomerVerify2faDto } from './dto/customer-verify-2fa.dto';
import { CustomerOAuthRedirectFilter } from './filters/customer-oauth-redirect.filter';
import {
  CustomerGoogleCallbackGuard,
  CustomerGoogleStartGuard,
} from './guards/customer-google-auth.guard';
import { CustomerJwtAuthGuard } from './guards/customer-jwt-auth.guard';
import type { CustomerGoogleProfile } from './interfaces/customer-google-profile.interface';
import type { CustomerPrincipal } from './interfaces/customer-principal.interface';
import type { SafeCustomerSession } from './customer-sessions.service';

type CustomerRequest = Request & {
  user: CustomerPrincipal;
};

type GoogleRequest = Request & {
  user: CustomerGoogleProfile;
};

interface AccessTokenResponse {
  accessToken: string;
}

interface TwoFactorRequiredResponse {
  twoFactorRequired: true;
  expiresIn: number;
}

interface TwoFactorSetupResponse {
  qrCodeDataUrl: string;
  secret: string;
}

/**
 * HTTP adapter for the customer authentication flow.
 *
 * Customer authentication is fully separate from staff authentication:
 * separate JWT secrets, guards, sessions, cookies and account entities.
 *
 * @Public() lets the global staff JwtAuthGuard skip these routes.
 * Routes requiring an authenticated customer additionally use
 * CustomerJwtAuthGuard.
 */
@Controller('customer/auth')
export class CustomerAuthController {
  constructor(
    private readonly authService: CustomerAuthService,
    private readonly cookies: CustomerCookiesService,
    private readonly frontend: CustomerFrontendService,
  ) {}

  @Public()
  @UseGuards(CustomerJwtAuthGuard)
  @Get('me')
  getCurrentAccount(
    @Req() req: CustomerRequest,
  ): CustomerPrincipal {
    return req.user;
  }

  /**
   * Starts Google OAuth for a customer.
   */
  @Public()
  @UseGuards(CustomerGoogleStartGuard)
  @Get('google')
  googleLogin(): void {
    // The guard sets the OAuth state cookie and Passport redirects
    // the browser to Google before this method body runs.
  }

  /**
   * Google returns the browser here.
   *
   * The backend creates a single-use code and binding cookie, then
   * redirects to the customer callback page in the frontend.
   */
  @Public()
  @UseGuards(CustomerGoogleCallbackGuard)
  @UseFilters(CustomerOAuthRedirectFilter)
  @Get('google/callback')
  async googleCallback(
    @Req() req: GoogleRequest,
    @Res() res: Response,
  ): Promise<void> {
    const handoff = await this.authService.beginGoogleLogin(
      req.user,
      {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      },
    );

    this.cookies.set(
      res,
      'binding',
      handoff.binding,
      handoff.expiresIn * 1000,
    );

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');

    res.redirect(
      this.frontend.callbackUrlWith({
        code: handoff.code,
      }),
    );
  }

  /**
   * Exchanges the single-use OAuth code and binding cookie.
   *
   * If 2FA is disabled, a complete session is issued.
   * If 2FA is enabled, only a temporary 2FA challenge is issued.
   */
  @Public()
  @Throttle({
    default: {
      limit: 10,
      ttl: 60_000,
    },
  })
  @Post('oauth/exchange')
  @HttpCode(HttpStatus.OK)
  async exchangeCode(
    @Body() dto: CustomerOAuthExchangeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<
    AccessTokenResponse | TwoFactorRequiredResponse
  > {
    res.setHeader('Cache-Control', 'no-store');

    const outcome = await this.authService.completeExchange(
      dto.code,
      this.cookies.read(req, 'binding'),
      {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      },
    );

    this.cookies.clear(res, 'binding');

    if (outcome.kind === 'two-factor') {
      this.cookies.set(
        res,
        'twoFactor',
        outcome.challenge,
        outcome.expiresIn * 1000,
      );

      return {
        twoFactorRequired: true,
        expiresIn: outcome.expiresIn,
      };
    }

    return this.issueSession(
      res,
      outcome.accessToken,
      outcome.refreshToken,
      outcome.sessionId,
    );
  }

  /**
   * Creates an encrypted pending TOTP secret and returns the QR code
   * and manual Base32 value to the authenticated customer.
   */
  @Public()
  @UseGuards(CustomerJwtAuthGuard)
  @Throttle({
    default: {
      limit: 5,
      ttl: 60_000,
    },
  })
  @Post('2fa/generate')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  generateTwoFactorSetup(
    @Req() req: CustomerRequest,
  ): Promise<TwoFactorSetupResponse> {
    return this.authService.generateTwoFactorSetup(
      req.user,
    );
  }

  /**
   * Verifies the generated TOTP code and enables 2FA.
   */
  @Public()
  @UseGuards(CustomerJwtAuthGuard)
  @Throttle({
    default: {
      limit: 5,
      ttl: 60_000,
    },
  })
  @Post('2fa/enable')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  enableTwoFactor(
    @Req() req: CustomerRequest,
    @Body() dto: CustomerVerify2faDto,
  ): Promise<{ message: string }> {
    return this.authService.enableTwoFactor(
      req.user,
      dto.code,
    );
  }

  /**
   * Verifies a current TOTP code, removes the encrypted secret
   * and disables 2FA.
   */
  @Public()
  @UseGuards(CustomerJwtAuthGuard)
  @Throttle({
    default: {
      limit: 5,
      ttl: 60_000,
    },
  })
  @Post('2fa/disable')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  disableTwoFactor(
    @Req() req: CustomerRequest,
    @Body() dto: CustomerVerify2faDto,
  ): Promise<{ message: string }> {
    return this.authService.disableTwoFactor(
      req.user,
      dto.code,
    );
  }

  /**
   * Completes a new login for an account with 2FA enabled.
   *
   * No access token, refresh token or live customer session exists
   * until this verification succeeds.
   */
  @Public()
  @Throttle({
    default: {
      limit: 10,
      ttl: 60_000,
    },
  })
  @Post('2fa/verify')
  @HttpCode(HttpStatus.OK)
  async verifyTwoFactor(
    @Body() dto: CustomerVerify2faDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccessTokenResponse> {
    res.setHeader('Cache-Control', 'no-store');

    const result =
      await this.authService.verifyTwoFactor(
        this.cookies.read(req, 'twoFactor'),
        dto.code,
        {
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
        },
      );

    this.cookies.clear(res, 'twoFactor');

    return this.issueSession(
      res,
      result.accessToken,
      result.refreshToken,
      result.sessionId,
    );
  }

  /**
   * Rotates the customer refresh token.
   *
   * The refresh cookie must be accompanied by the customer CSRF
   * token in the X-CSRF-Token header.
   */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-csrf-token') csrfToken?: string,
  ): Promise<AccessTokenResponse> {
    res.setHeader('Cache-Control', 'no-store');

    const result = await this.authService.refresh(
      this.cookies.read(req, 'refresh'),
      csrfToken,
    );

    return this.issueSession(
      res,
      result.accessToken,
      result.refreshToken,
      result.sessionId,
    );
  }

  /**
   * Logs the customer out of the current session.
   */
  @Public()
  @UseGuards(CustomerJwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: CustomerRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string }> {
    const result = await this.authService.logout(
      req.user,
      this.cookies.read(req, 'refresh'),
    );

    this.cookies.clearSessionCookies(res);

    return result;
  }

  /**
   * Returns the authenticated customer's active sessions.
   */
  @Public()
  @UseGuards(CustomerJwtAuthGuard)
  @Get('sessions')
  listSessions(
    @Req() req: CustomerRequest,
  ): Promise<SafeCustomerSession[]> {
    return this.authService.listSessions(req.user);
  }

  /**
   * Revokes one session belonging to the authenticated customer.
   */
  @Public()
  @UseGuards(CustomerJwtAuthGuard)
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.OK)
  revokeSession(
    @Req() req: CustomerRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ message: string }> {
    return this.authService.revokeSession(
      req.user,
      id,
    );
  }

  /**
   * Stores refresh and CSRF cookies and returns the access token.
   */
  private issueSession(
    res: Response,
    accessToken: string,
    refreshToken: string,
    sessionId: string,
  ): AccessTokenResponse {
    this.cookies.setSessionCookies(
      res,
      refreshToken,
      this.authService.computeCsrfToken(sessionId),
    );

    return {
      accessToken,
    };
  }
}