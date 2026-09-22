import { plainToInstance } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsString, Max, Min, validateSync, IsOptional, IsNotEmpty } from 'class-validator';

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

class EnvironmentVariables {
  @IsEnum(Environment)
  @IsOptional()
  NODE_ENV: Environment = Environment.Development;

  @IsInt()
  @Min(0)
  @Max(65535)
  PORT: number;

  @IsString()
  DB_HOST: string;

  @IsInt()
  DB_PORT: number;

  @IsString()
  DB_USERNAME: string;

  @IsString()
  DB_PASSWORD: string;

  @IsString()
  DB_NAME: string;

  @IsString()
  JWT_ACCESS_SECRET: string;

  @IsString()
  JWT_REFRESH_SECRET: string;

  @IsString()
  JWT_ACCESS_EXPIRES_IN: string;

  @IsString()
  JWT_REFRESH_EXPIRES_IN: string;

  @IsString()
  MAIL_HOST: string;

  @IsInt()
  MAIL_PORT: number;

  @IsString()
  MAIL_USER: string;

  @IsString()
  MAIL_PASSWORD: string;

  @IsString()
  MAIL_FROM: string;

  @IsString()
  FRONTEND_URL: string;

  // --- OAuth (Google / GitHub) ---
  // Optional at the validation level so the app still boots before these
  // are configured; GoogleStrategy/GithubStrategy log a warning and fall
  // back to placeholder values in that case (see their constructors) —
  // only the OAuth routes themselves fail until real values are set.
  @IsOptional()
  @IsString()
  GOOGLE_CLIENT_ID?: string;

  @IsOptional()
  @IsString()
  GOOGLE_CLIENT_SECRET?: string;

  @IsOptional()
  @IsString()
  GOOGLE_CALLBACK_URL?: string;

  @IsOptional()
  @IsString()
  GITHUB_CLIENT_ID?: string;

  @IsOptional()
  @IsString()
  GITHUB_CLIENT_SECRET?: string;

  @IsOptional()
  @IsString()
  GITHUB_CALLBACK_URL?: string;

  // --- Cookies / CSRF ---
  // Optional: AuthService.getAuthCookieSettings() falls back to 'none' in
  // production / 'lax' otherwise when this isn't set.
  @IsOptional()
  @IsIn(['lax', 'strict', 'none'])
  COOKIE_SAME_SITE?: 'lax' | 'strict' | 'none';

  // Optional: only needed for cross-subdomain deployments; see
  // AuthService.getAuthCookieSettings().
  @IsOptional()
  @IsString()
  COOKIE_DOMAIN?: string;

  // Required: HMAC key for the storage-free CSRF token — see
  // AuthService.computeCsrfToken().
  @IsString()
  CSRF_SECRET: string;

  // Required: signing key for the short-lived OAuth exchange code — see
  // AuthService.createOAuthExchangeCode()/exchangeOAuthCode().
  @IsString()
  OAUTH_CODE_SECRET: string;

  @IsString()
  STRIPE_SECRET_KEY: string;

  @IsString()
  STRIPE_WEBHOOK_SECRET: string;

  @IsString()
  @IsNotEmpty()
  IMGBB_API_KEY: string;

  // --- Customer Auth (Google-only) ---
  // Optional, same reasoning as GOOGLE_CLIENT_ID above: CustomerGoogleStrategy
  // falls back to placeholders so the app still boots; only
  // /v1/customer/auth/google fails until these are set.
  @IsOptional()
  @IsString()
  CUSTOMER_GOOGLE_CLIENT_ID?: string;

  @IsOptional()
  @IsString()
  CUSTOMER_GOOGLE_CLIENT_SECRET?: string;

  @IsOptional()
  @IsString()
  CUSTOMER_GOOGLE_CALLBACK_URL?: string;

  // Required: deliberately separate from JWT_ACCESS_SECRET/JWT_REFRESH_SECRET
  // so a staff token can never validate on a customer route and vice versa
  // (different secret => signature verification fails outright).
  @IsString()
  CUSTOMER_JWT_ACCESS_SECRET: string;

  @IsString()
  CUSTOMER_JWT_REFRESH_SECRET: string;

  // Required: HMAC key for the customer storage-free CSRF token, separate
  // from CSRF_SECRET for the same isolation reason as the JWT secrets above.
  @IsString()
  CUSTOMER_CSRF_SECRET: string;

  // Required: HMAC key for the signed Google `state` value of the customer
  // flow (see CustomerOAuthStateService). Must be at least 32 bytes — that
  // length check lives in the service, which fails fast at boot.
  @IsString()
  CUSTOMER_OAUTH_STATE_SECRET: string;

  // Optional: absolute URL of the customer OAuth callback PAGE in the
  // frontend (e.g. http://localhost:5173/customer/oauth/callback). When
  // unset, FRONTEND_URL + '/customer/oauth/callback' is used. This is the
  // only redirect target the Google callback will ever send a browser to.
  @IsOptional()
  @IsString()
  CUSTOMER_FRONTEND_CALLBACK_URL?: string;

  // Optional (kept for backwards compatibility, no longer read anywhere):
  // the customer exchange code is a DB-backed one-time code bound to an
  // httpOnly cookie, not a signed JWT, so it needs no signing key. It was
  // previously declared as required while never being set, which would
  // stop the whole app from booting.
  @IsOptional()
  @IsString()
  CUSTOMER_OAUTH_CODE_SECRET?: string;


  @IsString()
  @IsNotEmpty()
  CUSTOMER_2FA_ENCRYPTION_KEY: string;

  @IsString()
  @IsNotEmpty()
  STAFF_2FA_ENCRYPTION_KEY: string;
}

/**
 * Validates process.env against EnvironmentVariables at application bootstrap.
 * Fails fast with a clear error instead of surfacing confusing errors later.
 */
export function validate(config: Record<string, unknown>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validatedConfig, { skipMissingProperties: false });

  if (errors.length > 0) {
    throw new Error(
      `Config validation error: ${errors
        .map((e) => Object.values(e.constraints ?? {}).join(', '))
        .join('; ')}`,
    );
  }
  return validatedConfig;
}
