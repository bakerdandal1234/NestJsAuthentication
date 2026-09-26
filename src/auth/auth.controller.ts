import {
  Body,
  Controller,
  Get,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';
import { AuthService } from './auth.service';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { Verify2faDto } from './dto/verify-2fa.dto';
import { OAuthExchangeDto } from './dto/oauth-exchange.dto';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { GithubAuthGuard } from './guards/github-auth.guard';
import { OAuthProfile } from './interfaces/oauth-profile.interface';
import { SetPasswordDto } from './dto/set-password.dto';
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Public()
  @Post('register')
  register(@Body() dto: CreateUserDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Get('verify-email')
  verifyEmail(@Query() query: VerifyEmailDto) {
    return this.authService.verifyEmail(query.token);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } }) // stricter limit on login
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(dto.email, dto.password, dto.twoFactorCode, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Password was correct but a 2FA code is still required — nothing to
    // set cookies for yet, the client must resubmit with twoFactorCode.
    if ('twoFactorRequired' in result) {
      return result;
    }

    this.setAuthCookies(res, result.refreshToken, result.sessionId);
    return { accessToken: result.accessToken };
  }

  /**
   * Cookie-authenticated + CSRF-protected. No refresh token in the body —
   * it's read from the httpOnly `refresh_token` cookie, and the caller must
   * echo the (JS-readable) `csrf_token` cookie's value back as the
   * X-CSRF-Token header (see AuthService.computeCsrfToken()/refreshTokens()
   * for how that's verified without any server-side storage).
   */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-csrf-token') csrfToken?: string,
  ) {
    const refreshToken = req.cookies?.['refresh_token'];
    const result = await this.authService.refreshTokens(refreshToken, csrfToken);

    this.setAuthCookies(res, result.refreshToken, result.sessionId);
    return { accessToken: result.accessToken };
  }

  // -----------------------------------------------------------------
  // OAuth (Google / GitHub)
  // -----------------------------------------------------------------
  // The *Auth() handlers below have empty bodies on purpose: @UseGuards()
  // triggers Passport's redirect to the provider's consent screen before
  // the handler body would ever run. The *Callback() handlers are where
  // Passport lands after the provider redirects back with the result.
  //
  // Neither callback returns JSON: they set the same refresh_token/
  // csrf_token cookies as a normal login, mint a short-lived one-time
  // exchange code, and redirect the browser to the frontend with only that
  // opaque code in the URL — never an access or refresh token.

  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google')
  googleAuth() {
    // Intentionally empty — GoogleAuthGuard handles the redirect.
  }

  @Public()
  @UseGuards(GoogleAuthGuard)
  @Get('google/callback')
  async googleAuthCallback(@Req() req: Request, @Res() res: Response) {
    await this.handleOAuthCallback(req, res);
  }

  @Public()
  @UseGuards(GithubAuthGuard)
  @Get('github')
  githubAuth() {
    // Intentionally empty — GithubAuthGuard handles the redirect.
  }

  @Public()
  @UseGuards(GithubAuthGuard)
  @Get('github/callback')
  async githubAuthCallback(@Req() req: Request, @Res() res: Response) {
    await this.handleOAuthCallback(req, res);
  }

  /**
   * Redeems the one-time code minted by the OAuth callback redirect for a
   * fresh access token. The refresh_token/csrf_token cookies were already
   * set by the callback itself, so nothing further is issued here besides
   * the access token.
   */
  @Public()
  @Post('oauth/exchange')
  @HttpCode(HttpStatus.OK)
  exchangeOAuthCode(@Body() dto: OAuthExchangeDto) {
    return this.authService.exchangeOAuthCode(dto.code);
  }

  private async handleOAuthCallback(req: Request, res: Response): Promise<void> {
    const result = await this.authService.loginWithOAuth(req.user as OAuthProfile, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const settings = this.authService.getAuthCookieSettings();
    if ('twoFactorRequired' in result) {
      this.clearAuthCookies(res);
      res.cookie('staff_oauth_2fa', result.challenge, {
        httpOnly: true, secure: settings.secure, sameSite: settings.sameSite,
        domain: settings.domain, path: '/v1/auth/2fa', maxAge: result.expiresIn * 1000,
      });
      const frontendUrl = this.configService.get<string>('FRONTEND_URL');
      res.redirect(`${frontendUrl}/oauth/callback?twoFactorRequired=true`);
      return;
    }
    res.clearCookie('staff_oauth_2fa', {
      httpOnly: true, secure: settings.secure, sameSite: settings.sameSite,
      domain: settings.domain, path: '/v1/auth/2fa',
    });
    this.setAuthCookies(res, result.refreshToken, result.sessionId);

    const code = await this.authService.createOAuthExchangeCode(result.userId, result.sessionId);
    const frontendUrl = this.configService.get<string>('FRONTEND_URL');
    res.redirect(`${frontendUrl}/oauth/callback?code=${encodeURIComponent(code)}`);
  }

  /**
   * Cookie-authenticated (refresh_token) + the existing bearer access-token
   * requirement (this route is NOT @Public()). The refresh token identifies
   * *which* session to revoke; the access token identifies *whose* session
   * it must belong to (see AuthService.logout()).
   */
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @CurrentUser('id') userId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies?.['refresh_token'];
    const result = await this.authService.logout(userId, refreshToken);
    this.clearAuthCookies(res);
    return result;
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.token, dto.newPassword);
  }

  @Post('change-password')
@HttpCode(HttpStatus.OK)
changePassword(
  @CurrentUser('id') userId: string,
  @Body() dto: ChangePasswordDto,
) {
  return this.authService.changePassword(
    userId,
    dto.currentPassword,
    dto.newPassword,
  );
}

/**
   * Lets an authenticated OAuth-only account (no local password yet) set
   * one. Not @Public(): the global JwtAuthGuard requires a valid access
   * token, which is what identifies whose account gets the password.
   */
  @Post('set-password')
  @HttpCode(HttpStatus.OK)
  setPassword(
    @CurrentUser('id') userId: string,
    @Body() dto: SetPasswordDto,
  ) {
    return this.authService.setPassword(userId, dto.newPassword);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('2fa/verify')
  @HttpCode(HttpStatus.OK)
  async verifyOAuthTwoFactor(
    @Body() dto: Verify2faDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const frontendOrigin = new URL(this.configService.getOrThrow<string>('FRONTEND_URL')).origin;
    if (req.headers.origin !== frontendOrigin) {
      throw new ForbiddenException('Invalid request origin');
    }
    res.setHeader('Cache-Control', 'no-store');
    const result = await this.authService.verifyOAuthTwoFactor(
      req.cookies?.['staff_oauth_2fa'], dto.code,
      { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
    );
    const settings = this.authService.getAuthCookieSettings();
    res.clearCookie('staff_oauth_2fa', {
      httpOnly: true, secure: settings.secure, sameSite: settings.sameSite,
      domain: settings.domain, path: '/v1/auth/2fa',
    });
    this.setAuthCookies(res, result.refreshToken, result.sessionId);
    return { accessToken: result.accessToken };
  }

  @Post('2fa/generate')
  generateTwoFactor(@CurrentUser('id') userId: string) {
    return this.authService.generateTwoFactorSecret(userId);
  }

  @Post('2fa/enable')
  enableTwoFactor(@CurrentUser('id') userId: string, @Body() dto: Verify2faDto) {
    return this.authService.enableTwoFactor(userId, dto.code);
  }

  @Post('2fa/disable')
  disableTwoFactor(@CurrentUser('id') userId: string, @Body() dto: Verify2faDto) {
    return this.authService.disableTwoFactor(userId, dto.code);
  }

  @Get('login-history')
  loginHistory(@CurrentUser('id') userId: string) {
    return this.authService.getLoginHistory(userId);
  }

  // -----------------------------------------------------------------
  // Cookie helpers
  // -----------------------------------------------------------------

  /**
   * Issues both auth cookies together: `refresh_token` (httpOnly, scoped to
   * Path=/v1/auth since JS never needs it and it's the only path that ever
   * needs to receive it) and `csrf_token` (NOT httpOnly, scoped to Path=/
   * instead — unlike refresh_token, its entire purpose is to be read by
   * frontend JS via document.cookie, and Path restricts *that* just as much
   * as it restricts which requests carry the cookie: a cookie scoped to
   * /v1/auth is invisible to document.cookie on any frontend page whose URL
   * doesn't start with /v1/auth — i.e. every page of an SPA frontend.
   * Both still share the same expiry/sameSite/secure/domain settings from
   * AuthService.getAuthCookieSettings().
   */
  private setAuthCookies(res: Response, refreshToken: string, sessionId: string): void {
    const settings = this.authService.getAuthCookieSettings();
    const csrfToken = this.authService.computeCsrfToken(sessionId);

    const shared: CookieOptions = {
      secure: settings.secure,
      sameSite: settings.sameSite,
      maxAge: settings.maxAge,
      domain: settings.domain,
    };

    res.cookie('refresh_token', refreshToken, { ...shared, path: settings.path, httpOnly: true });
    res.cookie('csrf_token', csrfToken, { ...shared, path: '/', httpOnly: false });
  }

  /** Clears both auth cookies on logout. Options (including path) must match what set them for browsers to honor the clear. */
  private clearAuthCookies(res: Response): void {
    const settings = this.authService.getAuthCookieSettings();
    const shared: CookieOptions = {
      secure: settings.secure,
      sameSite: settings.sameSite,
      domain: settings.domain,
    };

    res.clearCookie('refresh_token', { ...shared, path: settings.path, httpOnly: true });
    res.clearCookie('csrf_token', { ...shared, path: '/', httpOnly: false });
  }
}
