require('reflect-metadata');
const {
  Module,
  ClassSerializerInterceptor,
  ValidationPipe,
  VersioningType,
} = require('@nestjs/common');
const { ConfigModule } = require('@nestjs/config');
const {
  NestFactory,
  APP_GUARD,
  APP_FILTER,
  APP_INTERCEPTOR,
} = require('@nestjs/core');
const { TypeOrmModule } = require('@nestjs/typeorm');
const { ThrottlerModule, ThrottlerGuard } = require('@nestjs/throttler');
const { DataSource } = require('typeorm');
const helmet = require('helmet');
const { parse: parseCookies } = require('cookie');
const { AuthModule } = require('../../src/auth/auth.module');
const { JwtAuthGuard } = require('../../src/common/guards/jwt-auth.guard');
const {
  PermissionsGuard,
} = require('../../src/common/guards/permissions.guard');
const {
  HttpExceptionFilter,
} = require('../../src/common/filters/http-exception.filter');
const { Role } = require('../../src/users/entities/role.entity');
const { DATABASE_ENTITIES } = require('../../src/config/database-options');
const {
  validate: validateEnvironment,
} = require('../../src/config/env.validation');

// These values belong only to the isolated test application, never to a real provider.
const testConfig = {
  NODE_ENV: 'test',
  FRONTEND_URL: 'http://localhost:5173',
  JWT_ACCESS_SECRET: 'oauth-test-access-secret-for-isolated-tests',
  JWT_ACCESS_EXPIRES_IN: '15m',
  JWT_REFRESH_SECRET: 'oauth-test-refresh-secret-for-isolated-tests',
  JWT_REFRESH_EXPIRES_IN: '7d',
  OAUTH_CODE_SECRET: 'oauth-test-exchange-secret-for-isolated-tests',
  CSRF_SECRET: 'oauth-test-csrf-secret-for-isolated-tests',
  STAFF_2FA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  GOOGLE_CLIENT_ID: 'google-test-client',
  GOOGLE_CLIENT_SECRET: 'google-test-secret',
  GITHUB_CLIENT_ID: 'github-test-client',
  GITHUB_CLIENT_SECRET: 'github-test-secret',
  GOOGLE_CALLBACK_URL: 'http://localhost/v1/auth/google/callback',
  GITHUB_CALLBACK_URL: 'http://localhost/v1/auth/github/callback',
  MAIL_HOST: '127.0.0.1',
  MAIL_PORT: 2525,
  MAIL_USER: 'test',
  MAIL_PASSWORD: 'test',
  MAIL_FROM: 'test@example.test',
  COOKIE_SAME_SITE: 'lax',
};

async function createOAuthApp({
  connection,
  config = testConfig,
  port = 0,
  throttleLimit = 10_000,
}) {
  const validatedConfig = validateEnvironment({
    ...config,
    PORT: port,
    DB_HOST: connection.host,
    DB_PORT: connection.port,
    DB_USERNAME: connection.username,
    DB_PASSWORD: 'isolated-test-password',
    DB_NAME: connection.database,
  });
  class OAuthTestApplication {}
  Module({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        ignoreEnvVars: true,
        skipProcessEnv: true,
        validate: () => validatedConfig,
        load: [() => validatedConfig],
      }),
      TypeOrmModule.forRoot({
        type: 'postgres',
        ...connection,
        entities: DATABASE_ENTITIES,
        synchronize: true,
        connectTimeoutMS: 10_000,
      }),
      ThrottlerModule.forRoot([{ ttl: 60_000, limit: throttleLimit }]),
      AuthModule,
    ],
    providers: [
      { provide: APP_GUARD, useClass: ThrottlerGuard },
      { provide: APP_GUARD, useClass: JwtAuthGuard },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: HttpExceptionFilter },
      { provide: APP_INTERCEPTOR, useClass: ClassSerializerInterceptor },
    ],
  })(OAuthTestApplication);
  const app = await NestFactory.create(OAuthTestApplication, {
    logger: false,
    abortOnError: false,
  });
  try {
    app.set('trust proxy', 1);
    app.use(helmet());
    app.use((request, _response, next) => {
      request.cookies = request.headers.cookie
        ? parseCookies(request.headers.cookie)
        : {};
      next();
    });
    app.enableCors({ origin: validatedConfig.FRONTEND_URL, credentials: true });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.listen(port, '127.0.0.1');
    const repository = app.get(DataSource).getRepository(Role);
    await repository.save(
      repository.create({
        name: 'user',
        description: 'Disposable test user role',
      }),
    );
    return {
      app,
      baseUrl: `http://127.0.0.1:${app.getHttpServer().address().port}`,
    };
  } catch (error) {
    await app.close();
    throw error;
  }
}

module.exports = { createOAuthApp, testConfig };
