import {
  Body,
  Controller,
  Get,
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
import { Verify2faDto } from './dto/verify-2fa.dto';
import { OAuthExchangeDto } from './dto/oauth-exchange.dto';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { GoogleAuthGuard } from './guards/google-auth.guard';
import { GithubAuthGuard } from './guards/github-auth.guard';
import { OAuthProfile } from './interfaces/oauth-profile.interface';

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

    this.setAuthCookies(res, result.refreshToken, result.sessionId);

    const code = await this.authService.createOAuthExchangeCode(result.userId);
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
   * Issues both auth cookies together: `refresh_token` (httpOnly — never
   * readable by frontend JS) and `csrf_token` (NOT httpOnly, so the React
   * frontend can read it via document.cookie and echo it back as
   * X-CSRF-Token on /auth/refresh). Both share the same expiry, path,
   * sameSite, secure, and domain settings from AuthService.getAuthCookieSettings();
   * only httpOnly differs between the two.
   */
  private setAuthCookies(res: Response, refreshToken: string, sessionId: string): void {
    const settings = this.authService.getAuthCookieSettings();
    const csrfToken = this.authService.computeCsrfToken(sessionId);

    const shared: CookieOptions = {
      secure: settings.secure,
      sameSite: settings.sameSite,
      path: settings.path,
      maxAge: settings.maxAge,
      domain: settings.domain,
    };

    res.cookie('refresh_token', refreshToken, { ...shared, httpOnly: true });
    res.cookie('csrf_token', csrfToken, { ...shared, httpOnly: false });
  }

  /** Clears both auth cookies on logout. Options must match what set them for browsers to honor the clear. */
  private clearAuthCookies(res: Response): void {
    const settings = this.authService.getAuthCookieSettings();
    const shared: CookieOptions = {
      secure: settings.secure,
      sameSite: settings.sameSite,
      path: settings.path,
      domain: settings.domain,
    };

    res.clearCookie('refresh_token', { ...shared, httpOnly: true });
    res.clearCookie('csrf_token', { ...shared, httpOnly: false });
  }
}
