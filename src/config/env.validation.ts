import { plainToInstance } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsString, Max, Min, validateSync, IsOptional } from 'class-validator';

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
