require('reflect-metadata');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { test } = require('node:test');
const { rootCertificates } = require('node:tls');
const { promisify } = require('node:util');
const { plainToInstance } = require('class-transformer');
const { validateSync } = require('class-validator');
const { NestFactory } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const { ConfigService } = require('@nestjs/config');
const { DataSource } = require('typeorm');
const bcrypt = require('bcryptjs');
const { AuthService } = require('../src/auth/auth.service');
const { AuthSessionService } = require('../src/auth/auth-session.service');
const { createHmac, randomUUID } = require('node:crypto');
const { CreateUserDto } = require('../src/users/dto/create-user.dto');
const { ResetPasswordDto } = require('../src/auth/dto/reset-password.dto');
const { ChangePasswordDto } = require('../src/auth/dto/change-password.dto');
const { LoginDto } = require('../src/auth/dto/login.dto');
const { GoogleStrategy } = require('../src/auth/strategies/google.strategy');
const { GithubStrategy } = require('../src/auth/strategies/github.strategy');
const { validate } = require('../src/config/env.validation');
const { parseTokenDurationMs } = require('../src/config/token-duration');
const { decodeTwoFactorKey } = require('../src/config/two-factor-key');
const { databaseOptions } = require('../src/config/database-options');
const { databaseTlsOptions } = require('../src/config/database-tls');
const { startPostgres, stopPostgres } = require('./helpers/postgres.cjs');

const validPassword = 'ValidPassword!234';

test('session cookie policy preserves development and production defaults and configured attributes', () => {
  for (const [environment, configuredSameSite, secure, sameSite] of [
    ['development', undefined, false, 'lax'],
    ['test', undefined, false, 'lax'],
    ['production', undefined, true, 'none'],
    ['development', 'none', true, 'none'],
    ['production', 'strict', true, 'strict'],
    ['development', 'strict', false, 'strict'],
  ]) {
    const sessionService = new AuthSessionService(
      undefined,
      new ConfigService({
        NODE_ENV: environment,
        COOKIE_SAME_SITE: configuredSameSite,
        JWT_REFRESH_EXPIRES_IN: '7d',
        COOKIE_DOMAIN: '',
      }),
    );
    const auth = new AuthService(undefined, sessionService);
    assert.deepEqual(auth.getAuthCookieSettings(), {
      httpOnly: true,
      secure,
      sameSite,
      path: '/v1/auth',
      maxAge: 604800000,
      domain: undefined,
    });
  }
  const sessionService = new AuthSessionService(
    undefined,
    new ConfigService({
      NODE_ENV: 'production',
      JWT_REFRESH_EXPIRES_IN: '2h',
      COOKIE_DOMAIN: '.example.test',
    }),
  );
  assert.equal(sessionService.getAuthCookieSettings().domain, '.example.test');
  assert.equal(sessionService.getAuthCookieSettings().maxAge, 7200000);
});

test('CSRF values remain compatible with existing clients and are bound to the secret and session', () => {
  const sessionId = randomUUID();
  const secret = 'isolated-csrf-compatibility-secret';
  const service = new AuthSessionService(
    undefined,
    new ConfigService({ CSRF_SECRET: secret }),
  );
  const auth = new AuthService(undefined, service);
  const expected = createHmac('sha256', secret).update(sessionId).digest('hex');
  assert.equal(auth.computeCsrfToken(sessionId), expected);
  assert.equal(
    auth.computeCsrfToken(sessionId),
    auth.computeCsrfToken(sessionId),
  );
  assert.notEqual(auth.computeCsrfToken(randomUUID()), expected);
  const other = new AuthSessionService(
    undefined,
    new ConfigService({ CSRF_SECRET: 'other-isolated-secret' }),
  );
  assert.notEqual(other.computeCsrfToken(sessionId), expected);
});
const validEnv = {
  NODE_ENV: 'development',
  PORT: '3000',
  DB_HOST: '127.0.0.1',
  DB_PORT: '5432',
  DB_USERNAME: 'postgres',
  DB_PASSWORD: 'test-database-password',
  DB_NAME: 'test_database',
  JWT_ACCESS_SECRET: 'a'.repeat(64),
  JWT_REFRESH_SECRET: 'r'.repeat(64),
  CSRF_SECRET: 'c'.repeat(64),
  OAUTH_CODE_SECRET: 'o'.repeat(64),
  JWT_ACCESS_EXPIRES_IN: '15m',
  JWT_REFRESH_EXPIRES_IN: '7d',
  STAFF_2FA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  MAIL_HOST: '127.0.0.1',
  MAIL_PORT: '2525',
  MAIL_USER: 'test',
  MAIL_PASSWORD: 'test-mail-password',
  MAIL_FROM: 'Test <test@example.test>',
  FRONTEND_URL: 'http://localhost:5173',
  GOOGLE_CLIENT_ID: 'google-test-client',
  GOOGLE_CLIENT_SECRET: 'google-test-secret',
  GOOGLE_CALLBACK_URL: 'http://localhost:3000/v1/auth/google/callback',
  GITHUB_CLIENT_ID: 'github-test-client',
  GITHUB_CLIENT_SECRET: 'github-test-secret',
  GITHUB_CALLBACK_URL: 'http://localhost:3000/v1/auth/github/callback',
  COOKIE_DOMAIN: '',
};
const productionEnv = {
  ...validEnv,
  NODE_ENV: 'production',
  FRONTEND_URL: 'https://app.example.test',
  GOOGLE_CALLBACK_URL: 'https://api.example.test/v1/auth/google/callback',
  GITHUB_CALLBACK_URL: 'https://api.example.test/v1/auth/github/callback',
};

const dtoInputs = [
  [
    CreateUserDto,
    'password',
    {
      email: 'test@example.test',
      firstName: 'Test',
      lastName: 'User',
      password: validPassword,
    },
  ],
  [
    ResetPasswordDto,
    'newPassword',
    { token: 'test-token', newPassword: validPassword },
  ],
  [
    ChangePasswordDto,
    'newPassword',
    { currentPassword: validPassword, newPassword: validPassword },
  ],
  [
    ChangePasswordDto,
    'currentPassword',
    { currentPassword: validPassword, newPassword: validPassword },
  ],
  [
    LoginDto,
    'password',
    { email: 'test@example.test', password: validPassword },
  ],
];
const byteBoundaries = [
  ['ASCII', 'Aa1!' + 'a'.repeat(67), 'Aa1!' + 'a'.repeat(68)],
  ['Arabic', 'Aa1!' + 'ع'.repeat(33) + 'a', 'Aa1!' + 'ع'.repeat(34)],
  ['emoji', 'Aa1!' + '😀'.repeat(16) + 'aaa', 'Aa1!' + '😀'.repeat(17)],
];

for (const [Dto, property, input] of dtoInputs) {
  test(`${Dto.name}.${property} accepts 71/72 bytes and rejects 73 bytes for ASCII, Arabic and emoji`, () => {
    for (const [encoding, below, limit] of byteBoundaries) {
      assert.equal(Buffer.byteLength(below), 71, encoding);
      assert.equal(Buffer.byteLength(limit), 72, encoding);
      for (const password of [below, limit]) {
        assert.deepEqual(
          validateSync(
            plainToInstance(Dto, { ...input, [property]: password }),
          ),
          [],
        );
      }
      const errors = validateSync(
        plainToInstance(Dto, { ...input, [property]: limit + 'a' }),
      );
      const passwordError = errors.find((error) => error.property === property);
      assert.match(passwordError.constraints.maxBcryptBytes, /72 bytes/);
    }
  });
}

test('password validation handles lone UTF-16 surrogates without an encodeURI exception', () => {
  const limit = 'Aa1!' + 'a'.repeat(65) + '\ud800';
  assert.equal(Buffer.byteLength(limit), 72);
  assert.deepEqual(
    validateSync(
      plainToInstance(CreateUserDto, { ...dtoInputs[0][2], password: limit }),
    ),
    [],
  );
  const errors = validateSync(
    plainToInstance(CreateUserDto, {
      ...dtoInputs[0][2],
      password: limit + 'a',
    }),
  );
  assert.ok(
    errors.find((error) => error.property === 'password').constraints
      .maxBcryptBytes,
  );
});

test('new-password validators still require eight characters and the existing complexity rules', () => {
  for (const [Dto, property, input] of dtoInputs.slice(0, 3)) {
    for (const password of [
      'Aa1!abc',
      'onlylowercase123',
      'ONLYUPPERCASE123',
      'NoNumbersOrSymbols',
    ]) {
      const errors = validateSync(
        plainToInstance(Dto, { ...input, [property]: password }),
      );
      assert.ok(errors.some((error) => error.property === property));
    }
  }
});

test('password DTOs reject non-string inputs without throwing', () => {
  for (const [Dto, property, input] of dtoInputs) {
    for (const password of [null, undefined, 42, {}, []]) {
      const errors = validateSync(
        plainToInstance(Dto, { ...input, [property]: password }),
      );
      assert.ok(errors.some((error) => error.property === property));
    }
  }
});

test('service entry points reject oversized passwords before reaching persistence or bcrypt', async () => {
  const auth = new AuthService();
  const oversized = 'Aa1!' + 'a'.repeat(69);
  const calls = [
    () => auth.register({ ...dtoInputs[0][2], password: oversized }),
    () => auth.login('test@example.test', oversized, undefined, {}),
    () => auth.resetPassword('test-token', oversized),
    () => auth.changePassword('test-user', validPassword, oversized),
    () => auth.changePassword('test-user', oversized, validPassword),
  ];
  for (const invoke of calls) {
    await assert.rejects(
      invoke(),
      (error) => error.getStatus?.() === 400 && /72 bytes/.test(error.message),
    );
  }
});

test('bcrypt ignores suffixes beyond 72 bytes, and the new validators reject both colliding inputs', async () => {
  const prefix = 'Aa1!' + 'a'.repeat(68);
  const hash = await bcrypt.hash(prefix + 'first-suffix', 4);
  assert.equal(await bcrypt.compare(prefix + 'different-suffix', hash), true);
  for (const suffix of ['first-suffix', 'different-suffix']) {
    const errors = validateSync(
      plainToInstance(LoginDto, {
        email: 'test@example.test',
        password: prefix + suffix,
      }),
    );
    assert.ok(
      errors.find((error) => error.property === 'password').constraints
        .maxBcryptBytes,
    );
  }
});

test('valid development config converts ports and normalizes a frontend origin without mutating input', () => {
  const input = { ...validEnv, FRONTEND_URL: 'http://LOCALHOST:5173/' };
  const config = validate(input);
  assert.equal(config.PORT, 3000);
  assert.equal(config.DB_PORT, 5432);
  assert.equal(config.MAIL_PORT, 2525);
  assert.equal(config.FRONTEND_URL, 'http://localhost:5173');
  assert.equal(input.FRONTEND_URL, 'http://LOCALHOST:5173/');
  const defaults = { ...validEnv };
  delete defaults.NODE_ENV;
  assert.equal(validate(defaults).NODE_ENV, 'development');
});

test('empty and missing required environment settings fail before startup', () => {
  for (const variable of [
    'DB_HOST',
    'DB_USERNAME',
    'DB_PASSWORD',
    'DB_NAME',
    'MAIL_HOST',
    'MAIL_USER',
    'MAIL_PASSWORD',
    'MAIL_FROM',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'FRONTEND_URL',
    'GOOGLE_CALLBACK_URL',
    'GITHUB_CALLBACK_URL',
    'STAFF_2FA_ENCRYPTION_KEY',
  ]) {
    for (const missing of [undefined, '', '   ']) {
      assert.throws(
        () => validate({ ...validEnv, [variable]: missing }),
        new RegExp(variable),
      );
    }
  }
});

test('all four signing/HMAC secrets require 32 characters and distinct values without exposing them', () => {
  const variables = [
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
    'CSRF_SECRET',
    'OAUTH_CODE_SECRET',
  ];
  for (const variable of variables) {
    for (const secret of [undefined, '', ' '.repeat(32), 'x'.repeat(31)]) {
      assert.throws(
        () => validate({ ...validEnv, [variable]: secret }),
        new RegExp(variable),
      );
    }
    assert.doesNotThrow(() =>
      validate({ ...validEnv, [variable]: 'x'.repeat(32) }),
    );
  }
  const privateSecret = 'private-do-not-print-secret-' + 'x'.repeat(40);
  assert.throws(
    () =>
      validate({
        ...validEnv,
        JWT_ACCESS_SECRET: privateSecret,
        OAUTH_CODE_SECRET: privateSecret,
      }),
    (error) =>
      /distinct secrets/.test(error.message) &&
      !error.message.includes(privateSecret),
  );
});

test('database and mail ports reject zero, out-of-range, fractional and malformed values', () => {
  for (const variable of ['DB_PORT', 'MAIL_PORT']) {
    for (const port of [0, -1, 65536, 1.5, '5432junk', 'invalid']) {
      assert.throws(
        () => validate({ ...validEnv, [variable]: port }),
        new RegExp(variable),
      );
    }
    for (const port of [1, 65535])
      assert.equal(validate({ ...validEnv, [variable]: port })[variable], port);
  }
  assert.equal(validate({ ...validEnv, PORT: 0 }).PORT, 0);
});

test('duration parsing and JWT expiry use the same units and reject invalid or unsafe ranges', async () => {
  const jwt = new JwtService();
  for (const [duration, milliseconds] of [
    ['1000ms', 1000],
    ['1s', 1000],
    ['15m', 900000],
    ['2h', 7200000],
    ['7d', 604800000],
  ]) {
    assert.equal(parseTokenDurationMs(duration), milliseconds);
    const token = await jwt.signAsync(
      { sub: 'test-user' },
      { secret: validEnv.JWT_ACCESS_SECRET, expiresIn: duration },
    );
    const claims = jwt.decode(token);
    assert.equal(claims.exp - claims.iat, milliseconds / 1000);
  }
  for (const duration of [
    '',
    '0s',
    '-1h',
    '1.5h',
    '999ms',
    '1000',
    '1w',
    ' 1h ',
    '9007199254740991d',
    '0'.repeat(100) + '1s',
  ]) {
    assert.throws(() => parseTokenDurationMs(duration));
    for (const variable of [
      'JWT_ACCESS_EXPIRES_IN',
      'JWT_REFRESH_EXPIRES_IN',
    ]) {
      assert.throws(
        () => validate({ ...validEnv, [variable]: duration }),
        new RegExp(variable),
      );
    }
  }
});

test('2FA key validation accepts exactly 32 canonical Base64 bytes and rejects malformed encodings', () => {
  assert.deepEqual(
    decodeTwoFactorKey(validEnv.STAFF_2FA_ENCRYPTION_KEY),
    Buffer.alloc(32, 7),
  );
  for (const encoded of [
    '',
    'not-base64',
    Buffer.alloc(31).toString('base64'),
    Buffer.alloc(33).toString('base64'),
    validEnv.STAFF_2FA_ENCRYPTION_KEY + '!',
    validEnv.STAFF_2FA_ENCRYPTION_KEY.replace(/=$/, ''),
    'A'.repeat(42) + 'B=',
  ]) {
    assert.throws(
      () => decodeTwoFactorKey(encoded),
      /STAFF_2FA_ENCRYPTION_KEY/,
    );
    assert.throws(
      () => validate({ ...validEnv, STAFF_2FA_ENCRYPTION_KEY: encoded }),
      /STAFF_2FA_ENCRYPTION_KEY/,
    );
  }
});

test('frontend URLs reject credentials, paths, queries and fragments; callbacks reject non-web schemes', () => {
  for (const url of [
    'localhost:5173',
    'ftp://localhost',
    'http://user:password@localhost',
    'http://localhost/app',
    'http://localhost?token=abc',
    'http://localhost#fragment',
  ]) {
    assert.throws(
      () => validate({ ...validEnv, FRONTEND_URL: url }),
      /FRONTEND_URL/,
    );
  }
  for (const variable of ['GOOGLE_CALLBACK_URL', 'GITHUB_CALLBACK_URL']) {
    for (const url of [
      'javascript:alert(1)',
      'ftp://localhost/callback',
      'http://user:password@localhost/callback',
      'http://localhost/callback#fragment',
    ]) {
      assert.throws(
        () => validate({ ...validEnv, [variable]: url }),
        new RegExp(variable),
      );
    }
  }
});

test('production requires HTTPS for the frontend and both provider callbacks', () => {
  assert.doesNotThrow(() => validate(productionEnv));
  for (const variable of [
    'FRONTEND_URL',
    'GOOGLE_CALLBACK_URL',
    'GITHUB_CALLBACK_URL',
  ]) {
    assert.throws(
      () =>
        validate({
          ...productionEnv,
          [variable]: productionEnv[variable].replace('https:', 'http:'),
        }),
      (error) =>
        error.message.includes(variable) && /HTTPS/.test(error.message),
    );
  }
});

test('unknown or empty NODE_ENV is rejected by app validation and database configuration', () => {
  for (const environment of ['staging', '', 'prod', 'Production']) {
    assert.throws(
      () => validate({ ...validEnv, NODE_ENV: environment }),
      /NODE_ENV/,
    );
    assert.throws(
      () => databaseOptions({ ...validEnv, NODE_ENV: environment }),
      /NODE_ENV/,
    );
  }
});

test('production database settings require certificate verification and leave schema synchronization disabled', () => {
  const options = databaseOptions(productionEnv);
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
  assert.equal(options.synchronize, false);
  assert.equal(options.logging, false);
  assert.equal(databaseOptions(validEnv).ssl, false);
  assert.equal(databaseTlsOptions({ NODE_ENV: 'test' }), false);
});

test('a valid private CA is passed to TLS and an invalid certificate fails without being printed', () => {
  const ca = rootCertificates[0];
  assert.deepEqual(
    databaseTlsOptions({ NODE_ENV: 'production', DB_SSL_CA: ca }),
    { rejectUnauthorized: true, ca },
  );
  assert.doesNotThrow(() => validate({ ...productionEnv, DB_SSL_CA: ca }));
  const malformedCa = 'PRIVATE-INVALID-CA-MUST-NOT-BE-PRINTED';
  assert.throws(
    () => databaseOptions({ ...productionEnv, DB_SSL_CA: malformedCa }),
    (error) =>
      /DB_SSL_CA/.test(error.message) && !error.message.includes(malformedCa),
  );
});

test('the shared database factory rejects missing credentials and malformed ports for CLI consumers too', () => {
  for (const variable of ['DB_HOST', 'DB_USERNAME', 'DB_PASSWORD', 'DB_NAME']) {
    for (const missing of [undefined, '', '   ']) {
      assert.throws(
        () => databaseOptions({ ...validEnv, [variable]: missing }),
        new RegExp(variable),
      );
    }
  }
  for (const port of ['0', '65536', '1.5', '5432junk']) {
    assert.throws(
      () => databaseOptions({ ...validEnv, DB_PORT: port }),
      /DB_PORT/,
    );
  }
});

test('the real AppModule and migration CLI initialize the same database without schema synchronization', async (context) => {
  const postgres = await startPostgres();
  const previousEnvironment = { ...process.env };
  let app;
  let cliDatabase;
  context.after(async () => {
    try {
      if (app) await app.close();
      if (cliDatabase?.isInitialized) await cliDatabase.destroy();
    } finally {
      for (const variable of Object.keys(process.env)) {
        if (!(variable in previousEnvironment)) delete process.env[variable];
      }
      Object.assign(process.env, previousEnvironment);
      await stopPostgres(postgres.directory);
    }
  });
  Object.assign(process.env, {
    ...validEnv,
    NODE_ENV: 'test',
    DB_HOST: postgres.connection.host,
    DB_PORT: String(postgres.connection.port),
    DB_USERNAME: postgres.connection.username,
    DB_NAME: postgres.connection.database,
    DB_SSL_CA: '',
    COOKIE_SAME_SITE: 'lax',
  });

  const { AppModule } = require('../src/app.module');
  app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  const nestDatabase = app.get(DataSource);
  assert.equal(nestDatabase.isInitialized, true);
  assert.equal(nestDatabase.options.port, postgres.connection.port);
  assert.equal(nestDatabase.options.synchronize, false);
  assert.equal(nestDatabase.options.ssl, false);
  assert.equal(app.get(ConfigService).get('DB_PORT'), postgres.connection.port);
  assert.deepEqual(
    await nestDatabase.query(
      'SELECT tablename FROM pg_tables WHERE schemaname = $1',
      ['public'],
    ),
    [],
  );

  cliDatabase = require('../src/config/data-source').AppDataSource;
  for (const option of [
    'type',
    'host',
    'port',
    'username',
    'password',
    'database',
    'entities',
    'synchronize',
    'logging',
    'ssl',
  ]) {
    assert.deepEqual(
      nestDatabase.options[option],
      cliDatabase.options[option],
      option,
    );
  }
  assert.deepEqual(cliDatabase.options.migrations, ['src/migrations/*.ts']);
  await cliDatabase.initialize();
  assert.ok(cliDatabase.migrations.length > 0);
  assert.deepEqual(
    await cliDatabase.query(
      'SELECT tablename FROM pg_tables WHERE schemaname = $1',
      ['public'],
    ),
    [],
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      'node_modules/typeorm/cli-ts-node-commonjs.js',
      '-d',
      'src/config/data-source.ts',
      'migration:show',
    ],
    { windowsHide: true, timeout: 60_000 },
  );
  for (const migration of cliDatabase.migrations) {
    assert.ok(
      stdout.includes(migration.name),
      `CLI did not discover ${migration.name}`,
    );
  }
});

test('OAuth strategies no longer construct with missing credential placeholders', () => {
  const config = new ConfigService({});
  assert.throws(() => new GoogleStrategy(config, {}), /GOOGLE_CLIENT_ID/);
  assert.throws(() => new GithubStrategy(config, {}), /GITHUB_CLIENT_ID/);
});
