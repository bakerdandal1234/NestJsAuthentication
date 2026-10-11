import { plainToInstance } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsString, IsUrl, Matches, Max, Min, MinLength, validateSync, IsOptional } from 'class-validator';
import { parseTokenDurationMs } from './token-duration';
import { decodeTwoFactorKey } from './two-factor-key';
import { databaseTlsOptions } from './database-tls';

const WEB_URL_OPTIONS = {
  protocols: ['http', 'https'], require_protocol: true, require_tld: false,
  disallow_auth: true, allow_fragments: false, allow_query_components: false,
};
const AUTH_SECRET_VARIABLES = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'CSRF_SECRET', 'OAUTH_CODE_SECRET'] as const;
const WEB_URL_VARIABLES = ['FRONTEND_URL', 'GOOGLE_CALLBACK_URL', 'GITHUB_CALLBACK_URL'] as const;

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

class EnvironmentVariables {
  @IsEnum(Environment)
  NODE_ENV: Environment = Environment.Development;

  @IsInt()
  @Min(0)
  @Max(65535)
  PORT: number;

  @IsString()
  @Matches(/\S/)
  DB_HOST: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  DB_PORT: number;

  @IsString()
  @Matches(/\S/)
  DB_USERNAME: string;

  @IsString()
  @Matches(/\S/)
  DB_PASSWORD: string;

  @IsString()
  @Matches(/\S/)
  DB_NAME: string;

  @IsOptional()
  @IsString()
  DB_SSL_CA?: string;

  @IsString()
  @MinLength(32)
  @Matches(/\S/)
  JWT_ACCESS_SECRET: string;

  @IsString()
  @MinLength(32)
  @Matches(/\S/)
  JWT_REFRESH_SECRET: string;

  @IsString()
  JWT_ACCESS_EXPIRES_IN: string;

  @IsString()
  JWT_REFRESH_EXPIRES_IN: string;

  @IsString()
  @Matches(/\S/)
  MAIL_HOST: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  MAIL_PORT: number;

  @IsString()
  @Matches(/\S/)
  MAIL_USER: string;

  @IsString()
  @Matches(/\S/)
  MAIL_PASSWORD: string;

  @IsString()
  @Matches(/\S/)
  MAIL_FROM: string;

  @IsString()
  @IsUrl(WEB_URL_OPTIONS)
  FRONTEND_URL: string;

  @IsString()
  @Matches(/\S/)
  GOOGLE_CLIENT_ID: string;

  @IsString()
  @Matches(/\S/)
  GOOGLE_CLIENT_SECRET: string;

  @IsString()
  @IsUrl(WEB_URL_OPTIONS)
  GOOGLE_CALLBACK_URL: string;

  @IsString()
  @Matches(/\S/)
  GITHUB_CLIENT_ID: string;

  @IsString()
  @Matches(/\S/)
  GITHUB_CLIENT_SECRET: string;

  @IsString()
  @IsUrl(WEB_URL_OPTIONS)
  GITHUB_CALLBACK_URL: string;

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
  @MinLength(32)
  @Matches(/\S/)
  CSRF_SECRET: string;

  // Required: signing key for the short-lived OAuth exchange code — see
  // AuthService.createOAuthExchangeCode()/exchangeOAuthCode().
  @IsString()
  @MinLength(32)
  @Matches(/\S/)
  OAUTH_CODE_SECRET: string;

  @IsString()
  STAFF_2FA_ENCRYPTION_KEY: string;
}

/**
 * Validates process.env against EnvironmentVariables at application bootstrap.
 * Fails fast with a clear error instead of surfacing confusing errors later.
 */
export function validate(config: Record<string, unknown>) {
  const validatedConfig = validatedEnvironment(config);
  validateTokenDurations(validatedConfig);
  decodeTwoFactorKey(validatedConfig.STAFF_2FA_ENCRYPTION_KEY);
  assertDistinctSecrets(validatedConfig);
  assertProductionHttps(validatedConfig);
  validatedConfig.FRONTEND_URL = frontendOrigin(validatedConfig.FRONTEND_URL);
  databaseTlsOptions({ NODE_ENV: validatedConfig.NODE_ENV, DB_SSL_CA: validatedConfig.DB_SSL_CA });
  return validatedConfig;
}

function validatedEnvironment(config: Record<string, unknown>): EnvironmentVariables {
  const environment = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(environment, { skipMissingProperties: false });

  if (errors.length > 0) {
    throw new Error(
      `Config validation error: ${errors
        .map((validationError) => Object.values(validationError.constraints ?? {}).join(', '))
        .join('; ')}`,
    );
  }
  return environment;
}

function validateTokenDurations(config: EnvironmentVariables): void {
  for (const variable of ['JWT_ACCESS_EXPIRES_IN', 'JWT_REFRESH_EXPIRES_IN'] as const) {
    try {
      parseTokenDurationMs(config[variable]);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new Error(`Config validation error: ${variable}: ${error.message}`, { cause: error });
    }
  }
}

function assertDistinctSecrets(config: EnvironmentVariables): void {
  const secrets = AUTH_SECRET_VARIABLES.map((variable) => config[variable]);
  if (new Set(secrets).size !== secrets.length) {
    throw new Error(`Config validation error: ${AUTH_SECRET_VARIABLES.join(', ')} must use distinct secrets`);
  }
}

function assertProductionHttps(config: EnvironmentVariables): void {
  if (config.NODE_ENV !== Environment.Production) return;
  for (const variable of WEB_URL_VARIABLES) {
    if (new URL(config[variable]).protocol !== 'https:') {
      throw new Error(`Config validation error: ${variable} must use HTTPS in production`);
    }
  }
}

function frontendOrigin(frontendUrl: string): string {
  const parsedUrl = new URL(frontendUrl);
  if (parsedUrl.pathname !== '/') {
    throw new Error('Config validation error: FRONTEND_URL must be an origin without a path');
  }
  return parsedUrl.origin;
}
