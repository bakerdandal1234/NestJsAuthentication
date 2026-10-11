require('reflect-metadata');
const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const { ConfigService } = require('@nestjs/config');
const { JwtService } = require('@nestjs/jwt');
const { DataSource } = require('typeorm');
const speakeasy = require('speakeasy');
const { AuthService } = require('../src/auth/auth.service');
const { OAuthStateService } = require('../src/auth/oauth-state.service');
const { OAuthState } = require('../src/auth/oauth-state.entity');
const { GoogleStrategy } = require('../src/auth/strategies/google.strategy');
const { GithubStrategy } = require('../src/auth/strategies/github.strategy');
const {
  StaffTwoFactorService,
} = require('../src/auth/staff-two-factor.service');
const { UsersService } = require('../src/users/users.service');
const { User } = require('../src/users/entities/user.entity');
const { LoginHistory } = require('../src/users/entities/login-history.entity');
const { Session } = require('../src/sessions/entities/session.entity');
const { SessionService } = require('../src/sessions/session.service');
const { createOAuthApp, testConfig } = require('./helpers/oauth-app.cjs');
const { startOAuthProvider } = require('./helpers/oauth-provider.cjs');
const { startPostgres, stopPostgres } = require('./helpers/postgres.cjs');
const { currentTotpStep, totpAtStep } = require('./helpers/totp.cjs');

let postgres;
let application;
let providerServer;
let database;
const digest = (token) => createHash('sha256').update(token).digest('hex');

before(
  async () => {
    postgres = await startPostgres();
    application = await createOAuthApp({ connection: postgres.connection });
    database = application.app.get(DataSource);
    providerServer = await startOAuthProvider();
    for (const [provider, strategy] of [
      ['google', GoogleStrategy],
      ['github', GithubStrategy],
    ]) {
      providerServer.configure(application.app.get(strategy), provider);
    }
  },
  { timeout: 240_000 },
);

after(
  async () => {
    try {
      if (application) await application.app.close();
    } finally {
      try {
        if (providerServer) await providerServer.close();
      } finally {
        if (postgres) await stopPostgres(postgres.directory);
      }
    }
  },
  { timeout: 60_000 },
);

function request(path, options = {}) {
  return fetch(`${application.baseUrl}/v1${path}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
    ...options,
  });
}

function cookie(response, name) {
  return response.headers
    .getSetCookie()
    .find((header) => header.startsWith(`${name}=`));
}

function cookiePair(response, name) {
  const header = cookie(response, name);
  assert.ok(header, `Missing ${name} cookie`);
  return header.split(';')[0];
}

async function begin(provider) {
  const response = await request(`/auth/${provider}`);
  assert.equal(response.status, 302);
  const authorization = new URL(response.headers.get('location'));
  assert.equal(authorization.searchParams.get('response_type'), 'code');
  assert.equal(
    authorization.searchParams.get('client_id'),
    `${provider}-test-client`,
  );
  assert.match(
    authorization.searchParams.get('scope'),
    provider === 'google' ? /email/ : /user:email/,
  );
  const state = authorization.searchParams.get('state');
  assert.match(state, /^[a-f0-9]{64}$/);
  return {
    provider,
    state,
    browserCookie: cookiePair(response, `oauth_${provider}_state`),
    response,
  };
}

async function callback(flow, identity = {}, overrides = {}) {
  const code =
    overrides.code ?? providerServer.authorize(flow.provider, identity);
  const parameters = new URLSearchParams({ code, state: flow.state });
  const headers = { cookie: flow.browserCookie, ...overrides.headers };
  return request(
    `/auth/${flow.provider}/callback?${overrides.query ?? parameters}`,
    { headers },
  );
}

async function finish(provider = 'google', identity = {}) {
  const flow = await begin(provider);
  const response = await callback(flow, identity);
  assert.equal(response.status, 302, await response.text());
  const frontend = new URL(response.headers.get('location'));
  assert.equal(frontend.origin, testConfig.FRONTEND_URL);
  assert.equal(frontend.pathname, '/oauth/callback');
  const code = frontend.searchParams.get('code');
  assert.ok(code);
  const refreshCookie = cookiePair(response, 'refresh_token');
  const payload = application.app.get(JwtService).decode(code);
  return { flow, response, code, refreshCookie, payload };
}

function exchange(
  login,
  {
    origin = testConfig.FRONTEND_URL,
    refreshCookie = login.refreshCookie,
    code = login.code,
  } = {},
) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin !== undefined && origin !== null) headers.origin = origin;
  if (refreshCookie) headers.cookie = refreshCookie;
  return request('/auth/oauth/exchange', {
    method: 'POST',
    headers,
    body: JSON.stringify({ code }),
  });
}

function session(login) {
  return database
    .getRepository(Session)
    .findOneByOrFail({ id: login.payload.sid });
}

async function assertCodeUnconsumed(login) {
  assert.equal(
    (await session(login)).oauthExchangeCodeHash,
    digest(login.code),
  );
}

// Cases: missing/null, empty/blank, other JSON types, unsafe numbers, valid opaque strings and numeric GitHub IDs.
for (const provider of ['google', 'github']) {
  const invalidIds = [
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['blank', ' \t\n'],
    ['boolean', true],
    ['object', { id: randomUUID() }],
    ['empty array', []],
    ['array', [randomUUID()]],
    ...(provider === 'google'
      ? [['numeric', 42]]
      : [
          ['zero', 0],
          ['negative', -1],
          ['fractional', 1.5],
          ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
        ]),
  ];
  for (const [label, id] of invalidIds) {
    test(`${provider}: provider identity validation rejects a ${label} ID before account lookup`, async (context) => {
      const user = await linkingAccount();
      const users = application.app.get(UsersService);
      const lookupMethod =
        provider === 'google' ? 'findByGoogleId' : 'findByGithubId';
      const lookup = context.mock.method(users, lookupMethod);
      const repository = database.getRepository(User);
      const before = await repository.findOneByOrFail({ id: user.id });
      const userCount = await repository.count();
      const sessionCount = await database.getRepository(Session).count();
      const historyCount = await database.getRepository(LoginHistory).count();
      const rejected = await callback(await begin(provider), {
        id,
        email: user.email,
      });
      const redirect = rejected.headers.get('location');
      const granted = redirect
        ? application.app
            .get(JwtService)
            .decode(new URL(redirect).searchParams.get('code'))
        : null;
      assert.equal(
        rejected.status,
        400,
        `Unexpected authenticated subject: ${granted?.sub}`,
      );
      assert.equal(
        (await rejected.json()).message,
        'OAuth provider did not provide a valid user identifier',
      );
      assert.equal(lookup.mock.callCount(), 0);
      assert.equal(cookie(rejected, 'refresh_token'), undefined);
      assert.equal(cookie(rejected, 'csrf_token'), undefined);
      assert.deepEqual(
        await repository.findOneByOrFail({ id: user.id }),
        before,
      );
      assert.equal(await repository.count(), userCount);
      assert.equal(await database.getRepository(Session).count(), sessionCount);
      assert.equal(
        await database.getRepository(LoginHistory).count(),
        historyCount,
      );
    });
  }

  test(`${provider}: provider identity validation rejects a missing ID without verified email even when accounts exist`, async (context) => {
    await linkingAccount({ [`${provider}Id`]: 'undefined' });
    const users = application.app.get(UsersService);
    const lookup = context.mock.method(
      users,
      provider === 'google' ? 'findByGoogleId' : 'findByGithubId',
    );
    const before = await database
      .getRepository(User)
      .find({ order: { id: 'ASC' } });
    const sessionCount = await database.getRepository(Session).count();
    const historyCount = await database.getRepository(LoginHistory).count();
    const rejected = await callback(await begin(provider), {
      id: undefined,
      email: undefined,
      verified: false,
    });
    assert.equal(rejected.status, 400);
    assert.equal(
      (await rejected.json()).message,
      'OAuth provider did not provide a valid user identifier',
    );
    assert.equal(lookup.mock.callCount(), 0);
    assert.equal(cookie(rejected, 'refresh_token'), undefined);
    assert.deepEqual(
      await database.getRepository(User).find({ order: { id: 'ASC' } }),
      before,
    );
    assert.equal(await database.getRepository(Session).count(), sessionCount);
    assert.equal(
      await database.getRepository(LoginHistory).count(),
      historyCount,
    );
  });
}

for (const [provider, id] of [
  ['google', '10769150350006150715113082367'],
  ['github', 1],
  ['github', Number.MAX_SAFE_INTEGER],
]) {
  test(`${provider}: provider identity validation preserves valid ID ${id} through login and subsequent lookup`, async () => {
    const initialLogin = await finish(provider, { id });
    const repository = database.getRepository(User);
    const before = await repository.findOneByOrFail({
      id: initialLogin.payload.sub,
    });
    assert.equal(before[`${provider}Id`], String(id));
    assert.equal((await exchange(initialLogin)).status, 200);
    const subsequentLogin = await finish(provider, {
      id,
      email: undefined,
      verified: false,
    });
    assert.equal(subsequentLogin.payload.sub, before.id);
    assert.deepEqual(
      await repository.findOneByOrFail({ id: before.id }),
      before,
    );
    const accessToken = (await (await exchange(subsequentLogin)).json())
      .accessToken;
    const profile = await request('/users/me', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(profile.status, 200);
    assert.equal((await profile.json()).id, before.id);
  });
}

for (const provider of ['google', 'github']) {
  test(`${provider}: complete HTTP login, protected profile, refresh, logout and session invalidation`, async () => {
    const identity = {
      id: randomUUID(),
      email: `${randomUUID()}@example.test`,
    };
    const login = await finish(provider, identity);
    const user = await database
      .getRepository(User)
      .findOneByOrFail({ id: login.payload.sub });
    assert.equal(user[`${provider}Id`], identity.id);
    assert.equal(user.email, identity.email);
    assert.equal(user.password, null);
    assert.equal(user.isEmailVerified, true);
    assert.equal(login.response.headers.get('cache-control'), 'no-store');
    assert.equal(login.response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(cookie(login.response, 'refresh_token'), /HttpOnly/);
    assert.match(cookie(login.response, 'refresh_token'), /Path=\/v1\/auth/);
    assert.ok(!/HttpOnly/.test(cookie(login.response, 'csrf_token')));
    const beforeExchange = await session(login);
    assert.equal(beforeExchange.oauthExchangeCodeHash, digest(login.code));
    assert.equal(
      beforeExchange.refreshTokenHash,
      digest(decodeURIComponent(login.refreshCookie.split('=')[1])),
    );
    const redeemed = await exchange(login);
    assert.equal(redeemed.status, 200);
    assert.equal(redeemed.headers.get('cache-control'), 'no-store');
    const { accessToken } = await redeemed.json();
    const profileResponse = await request('/users/me', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(profileResponse.status, 200);
    const profile = await profileResponse.json();
    assert.equal(profile.id, user.id);
    assert.equal(profile.hasPassword, false);
    for (const secret of [
      'password',
      'twoFactorSecret',
      'twoFactorLastUsedStep',
      'passwordResetToken',
      'emailVerificationToken',
    ]) {
      assert.ok(!(secret in profile));
    }
    const authorization = await request('/users/me/access', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.deepEqual((await authorization.json()).roles, ['user']);
    const safeSessions = await request('/sessions', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const listed = await safeSessions.json();
    assert.equal(listed.length, 1);
    for (const secret of [
      'refreshTokenHash',
      'oauthExchangeCodeHash',
      'oauthExchangeCodeExpiresAt',
    ]) {
      assert.ok(!(secret in listed[0]));
    }
    assert.equal((await session(login)).oauthExchangeCodeHash, null);
    assert.equal((await session(login)).oauthExchangeCodeExpiresAt, null);
    assert.equal((await exchange(login)).status, 401);
    const refreshed = await request('/auth/refresh', {
      method: 'POST',
      headers: {
        cookie: login.refreshCookie,
        'x-csrf-token': decodeURIComponent(
          cookiePair(login.response, 'csrf_token').split('=')[1],
        ),
      },
    });
    assert.equal(refreshed.status, 200);
    const newToken = (await refreshed.json()).accessToken;
    const logout = await request('/auth/logout', {
      method: 'POST',
      headers: {
        cookie: cookiePair(refreshed, 'refresh_token'),
        authorization: `Bearer ${newToken}`,
      },
    });
    assert.equal(logout.status, 200);
    assert.equal(
      (
        await request('/users/me', {
          headers: { authorization: `Bearer ${newToken}` },
        })
      ).status,
      401,
    );
    const repeatedLogin = await finish(provider, identity);
    assert.equal(repeatedLogin.payload.sub, user.id);
  });

  test(`${provider}: state is hashed, browser-bound and set in a host-only HttpOnly Lax cookie`, async () => {
    const flow = await begin(provider);
    const row = await database
      .getRepository(OAuthState)
      .findOneByOrFail({ stateHash: digest(flow.state) });
    assert.equal(
      row.browserTokenHash,
      digest(flow.browserCookie.split('=')[1]),
    );
    assert.equal(row.provider, provider);
    assert.ok(row.expiresAt.getTime() > Date.now());
    assert.ok(row.expiresAt.getTime() <= Date.now() + 600_000);
    const header = cookie(flow.response, `oauth_${provider}_state`);
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Lax/);
    assert.match(header, /Path=\//);
    assert.match(header, /Max-Age=600/);
    assert.ok(!/Domain=/.test(header));
    assert.notEqual(flow.state, flow.browserCookie.split('=')[1]);
  });

  test(`${provider}: missing, empty, malformed and repeated state and missing/wrong browser cookies fail before provider redemption`, async () => {
    const flow = await begin(provider);
    const code = providerServer.authorize(provider);
    const attempts = [
      { query: `code=${code}` },
      { query: `code=${code}&state=` },
      { query: `code=${code}&state=bad` },
      { query: `code=${code}&state=${flow.state}&state=${flow.state}` },
      { headers: { cookie: '' } },
      {
        headers: {
          cookie: `oauth_${provider}_state=${randomBytes(32).toString('hex')}`,
        },
      },
    ];
    const beforeRequests = providerServer.tokenRequests;
    for (const invalid of attempts)
      assert.equal(
        (await callback(flow, {}, { code, ...invalid })).status,
        401,
      );
    assert.equal(providerServer.tokenRequests, beforeRequests);
    assert.ok(
      await database
        .getRepository(OAuthState)
        .findOneBy({ stateHash: digest(flow.state) }),
    );
    const valid = await callback(flow, {}, { code });
    assert.equal(valid.status, 302);
    assert.match(
      cookie(valid, `oauth_${provider}_state`),
      /Expires=Thu, 01 Jan 1970/,
    );
    assert.equal(
      await database
        .getRepository(OAuthState)
        .findOneBy({ stateHash: digest(flow.state) }),
      null,
    );
  });

  test(`${provider}: expired state and callback replay are rejected`, async () => {
    const flow = await begin(provider);
    await database
      .getRepository(OAuthState)
      .update(
        { stateHash: digest(flow.state) },
        { expiresAt: new Date(Date.now() - 1000) },
      );
    const beforeRequests = providerServer.tokenRequests;
    assert.equal((await callback(flow)).status, 401);
    assert.equal(providerServer.tokenRequests, beforeRequests);
    const fresh = await begin(provider);
    const code = providerServer.authorize(provider);
    assert.equal((await callback(fresh, {}, { code })).status, 302);
    assert.equal((await callback(fresh, {}, { code })).status, 401);
    assert.equal(providerServer.tokenRequests, beforeRequests + 1);
  });

  test(`${provider}: simultaneous callbacks consume state exactly once`, async () => {
    const flow = await begin(provider);
    const code = providerServer.authorize(provider);
    const beforeRequests = providerServer.tokenRequests;
    const responses = await Promise.all([
      callback(flow, {}, { code }),
      callback(flow, {}, { code }),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [302, 401],
    );
    assert.equal(providerServer.tokenRequests, beforeRequests + 1);
  });

  test(`${provider}: verified email links a local account; unverified email cannot link or create`, async () => {
    const repository = database.getRepository(User);
    const existing = await repository.save(
      repository.create({
        email: `${randomUUID()}@example.test`,
        isEmailVerified: true,
      }),
    );
    const providerId = randomUUID();
    const unverified = await callback(await begin(provider), {
      id: providerId,
      email: existing.email,
      verified: false,
    });
    assert.equal(unverified.status, 400);
    assert.equal(
      (await repository.findOneByOrFail({ id: existing.id }))[`${provider}Id`],
      null,
    );
    const newEmail = `${randomUUID()}@example.test`;
    assert.equal(
      (
        await callback(await begin(provider), {
          email: newEmail,
          verified: false,
        })
      ).status,
      400,
    );
    assert.equal(await repository.findOneBy({ email: newEmail }), null);
    const linked = await finish(provider, {
      id: providerId,
      email: existing.email,
    });
    assert.equal(linked.payload.sub, existing.id);
    assert.equal(
      (await repository.findOneByOrFail({ id: existing.id }))[`${provider}Id`],
      providerId,
    );
  });

  test(`${provider}: a locked account receives no session; 2FA must finish before authentication`, async () => {
    const identity = {
      id: randomUUID(),
      email: `${randomUUID()}@example.test`,
    };
    const repository = database.getRepository(User);
    const user = await repository.save(
      repository.create({
        email: identity.email,
        [`${provider}Id`]: identity.id,
        isEmailVerified: true,
        lockedUntil: new Date(Date.now() + 60_000),
      }),
    );
    assert.equal((await callback(await begin(provider), identity)).status, 403);
    assert.equal(
      await database.getRepository(Session).countBy({ userId: user.id }),
      0,
    );
    await repository.update({ id: user.id }, { lockedUntil: () => 'NULL' });
    const twoFactor = application.app.get(StaffTwoFactorService);
    const setup = await twoFactor.generateSetup(user.id);
    await twoFactor.enable(
      user.id,
      totpAtStep(setup.secret, (await currentTotpStep()) - 1),
    );
    const challenged = await callback(await begin(provider), identity);
    assert.equal(challenged.status, 302);
    const redirect = new URL(challenged.headers.get('location'));
    assert.equal(redirect.searchParams.get('twoFactorRequired'), 'true');
    assert.equal(redirect.searchParams.has('code'), false);
    assert.equal(
      await database.getRepository(Session).countBy({ userId: user.id }),
      0,
    );
    const challengeCookie = cookiePair(challenged, 'staff_oauth_2fa');
    const verify = () =>
      request('/auth/2fa/verify', {
        method: 'POST',
        headers: {
          cookie: challengeCookie,
          origin: testConfig.FRONTEND_URL,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          code: speakeasy.totp({ secret: setup.secret, encoding: 'base32' }),
        }),
      });
    const verified = await verify();
    assert.equal(verified.status, 200);
    assert.ok((await verified.json()).accessToken);
    assert.equal(
      await database.getRepository(Session).countBy({ userId: user.id }),
      1,
    );
    assert.equal((await verify()).status, 401);
  });
}

test('state cannot be moved between providers or between browsers', async () => {
  const google = await begin('google');
  const github = await begin('github');
  const beforeRequests = providerServer.tokenRequests;
  assert.equal(
    (
      await callback(
        { ...github, state: google.state },
        {},
        {
          headers: {
            cookie: `oauth_github_state=${google.browserCookie.split('=')[1]}`,
          },
        },
      )
    ).status,
    401,
  );
  const secondBrowser = await begin('google');
  assert.equal(
    (
      await callback(
        google,
        {},
        { headers: { cookie: secondBrowser.browserCookie } },
      )
    ).status,
    401,
  );
  assert.equal(providerServer.tokenRequests, beforeRequests);
});

test('frontend CORS preflight allows the credentialed exchange request', async () => {
  const response = await request('/auth/oauth/exchange', {
    method: 'OPTIONS',
    headers: {
      origin: testConfig.FRONTEND_URL,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get('access-control-allow-origin'),
    testConfig.FRONTEND_URL,
  );
  assert.equal(
    response.headers.get('access-control-allow-credentials'),
    'true',
  );
});

test('the frontend may refresh its session before exchanging the OAuth code', async () => {
  const login = await finish();
  const refreshed = await request('/auth/refresh', {
    method: 'POST',
    headers: {
      cookie: login.refreshCookie,
      'x-csrf-token': decodeURIComponent(
        cookiePair(login.response, 'csrf_token').split('=')[1],
      ),
    },
  });
  assert.equal(refreshed.status, 200);
  const rotatedCookie = cookiePair(refreshed, 'refresh_token');
  assert.notEqual(rotatedCookie, login.refreshCookie);
  assert.equal((await exchange(login)).status, 401);
  await assertCodeUnconsumed(login);
  assert.equal(
    (await exchange(login, { refreshCookie: rotatedCookie })).status,
    200,
  );
});

test('production state cookies use __Host-, Secure, HttpOnly, Lax and matching clearing attributes', async () => {
  const stateService = new OAuthStateService(
    database.getRepository(OAuthState),
    new ConfigService({ NODE_ENV: 'production' }),
  );
  const store = stateService.forProvider('google');
  const written = [];
  const cleared = [];
  const request = {
    cookies: {},
    res: {
      cookie: (...cookieArguments) => written.push(cookieArguments),
      clearCookie: (...cookieArguments) => cleared.push(cookieArguments),
    },
  };
  const state = await new Promise((resolve, reject) =>
    store.store(request, (error, token) =>
      error ? reject(error) : resolve(token),
    ),
  );
  assert.equal(written[0][0], '__Host-oauth_google_state');
  assert.deepEqual(written[0][2], {
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    secure: true,
    maxAge: 600_000,
  });
  request.cookies[written[0][0]] = written[0][1];
  await new Promise((resolve, reject) =>
    store.verify(request, state, (error, verified) =>
      error ? reject(error) : resolve(verified),
    ),
  );
  assert.deepEqual(cleared[0], [
    '__Host-oauth_google_state',
    { httpOnly: true, path: '/', sameSite: 'lax', secure: true },
  ]);
});

test('exchange requires the exact frontend origin and the matching browser refresh cookie without burning a valid code', async () => {
  const login = await finish();
  for (const options of [
    { origin: null },
    { origin: 'https://attacker.example' },
  ]) {
    assert.equal((await exchange(login, options)).status, 403);
    await assertCodeUnconsumed(login);
  }
  const other = await finish('github');
  for (const refreshCookie of [
    '',
    'refresh_token=wrong',
    other.refreshCookie,
  ]) {
    assert.equal((await exchange(login, { refreshCookie })).status, 401);
    await assertCodeUnconsumed(login);
  }
  assert.equal((await exchange(login)).status, 200);
});

async function linkingAccount(overrides = {}) {
  const repository = database.getRepository(User);
  return repository.save(
    repository.create({
      email: `${randomUUID()}@example.test`,
      firstName: 'Original',
      lastName: 'Account',
      isEmailVerified: true,
      failedLoginAttempts: 2,
      lockedUntil: new Date(Date.now() - 1_000),
      passwordResetToken: randomBytes(32).toString('hex'),
      passwordResetExpires: new Date(Date.now() + 60_000),
      ...overrides,
    }),
  );
}

function synchronizeLinks(context, userId) {
  const users = application.app.get(UsersService);
  const link = users.linkOAuthAccount.bind(users);
  let arrivals = 0;
  let release;
  const bothReady = new Promise((resolve) => {
    release = resolve;
  });
  context.mock.method(users, 'linkOAuthAccount', async (...arguments_) => {
    if (arguments_[0] !== userId) return link(...arguments_);
    if (++arrivals === 2) release();
    await bothReady;
    return link(...arguments_);
  });
  return release;
}

async function rejectLinkUpdate(operation) {
  await database.query(`CREATE FUNCTION reject_oauth_link_write() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'forced OAuth link failure' USING ERRCODE = '23502'; END;
    $$ LANGUAGE plpgsql`);
  await database.query(`CREATE TRIGGER reject_oauth_link_write BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION reject_oauth_link_write()`);
  try {
    await operation();
  } finally {
    await database.query('DROP TRIGGER reject_oauth_link_write ON users');
    await database.query('DROP FUNCTION reject_oauth_link_write()');
  }
}

// Cases: empty/same/different link, competing identities, the other provider, uniqueness conflicts and unexpected database failures.
for (const provider of ['google', 'github']) {
  test(`${provider}: linking protection rejects replacing an existing provider identity even with verified email`, async () => {
    const repository = database.getRepository(User);
    const existingIdentity = randomUUID();
    const user = await linkingAccount({ [`${provider}Id`]: existingIdentity });
    const initialLogin = await finish(provider, {
      id: existingIdentity,
      email: user.email,
    });
    const accessToken = (await (await exchange(initialLogin)).json())
      .accessToken;
    const before = await repository.findOneByOrFail({ id: user.id });
    const rejected = await callback(await begin(provider), {
      id: randomUUID(),
      email: user.email,
      verified: true,
    });
    assert.equal(rejected.status, 409);
    assert.equal(
      (await rejected.json()).message,
      'OAuth identity conflicts with an existing account link',
    );
    assert.equal(cookie(rejected, 'refresh_token'), undefined);
    assert.deepEqual(await repository.findOneByOrFail({ id: user.id }), before);
    assert.equal(
      await database.getRepository(Session).countBy({ userId: user.id }),
      1,
    );
    assert.equal(
      await database.getRepository(LoginHistory).countBy({ userId: user.id }),
      1,
    );
    const stillAuthenticated = await request('/users/me', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(stillAuthenticated.status, 200);
    const legitimate = await finish(provider, {
      id: existingIdentity,
      email: `${randomUUID()}@example.test`,
      verified: false,
    });
    assert.equal(legitimate.payload.sub, user.id);
    assert.equal((await exchange(legitimate)).status, 200);
  });

  test(
    `${provider}: linking protection allows only one of two simultaneous different identities`,
    { timeout: 20_000 },
    async (context) => {
      const user = await linkingAccount();
      const before = await database.getRepository(User).findOneByOrFail({
        id: user.id,
      });
      const identities = [randomUUID(), randomUUID()];
      const flows = await Promise.all([begin(provider), begin(provider)]);
      const release = synchronizeLinks(context, user.id);
      let responses;
      try {
        responses = await Promise.all(
          flows.map((flow, index) =>
            callback(flow, { id: identities[index], email: user.email }),
          ),
        );
      } finally {
        release();
      }
      assert.deepEqual(
        responses.map((response) => response.status).sort(),
        [302, 409],
      );
      const winner = responses.findIndex((response) => response.status === 302);
      const stored = await database.getRepository(User).findOneByOrFail({
        id: user.id,
      });
      assert.equal(stored[`${provider}Id`], identities[winner]);
      assert.equal(stored.failedLoginAttempts, before.failedLoginAttempts);
      assert.deepEqual(stored.lockedUntil, before.lockedUntil);
      assert.equal(stored.passwordResetToken, before.passwordResetToken);
      assert.equal(
        await database.getRepository(Session).countBy({ userId: user.id }),
        1,
      );
      assert.equal(
        await database.getRepository(LoginHistory).countBy({ userId: user.id }),
        1,
      );
      assert.equal(cookie(responses[1 - winner], 'refresh_token'), undefined);
    },
  );

  test(
    `${provider}: linking protection permits simultaneous callbacks for the same identity`,
    { timeout: 20_000 },
    async (context) => {
      const user = await linkingAccount();
      const providerId = randomUUID();
      const flows = await Promise.all([begin(provider), begin(provider)]);
      const release = synchronizeLinks(context, user.id);
      let responses;
      try {
        responses = await Promise.all(
          flows.map((flow) =>
            callback(flow, { id: providerId, email: user.email }),
          ),
        );
      } finally {
        release();
      }
      assert.deepEqual(
        responses.map((response) => response.status),
        [302, 302],
      );
      assert.equal(
        (await database.getRepository(User).findOneByOrFail({ id: user.id }))[
          `${provider}Id`
        ],
        providerId,
      );
      assert.equal(
        await database.getRepository(Session).countBy({ userId: user.id }),
        2,
      );
      assert.equal(
        await database.getRepository(LoginHistory).countBy({ userId: user.id }),
        2,
      );
    },
  );

  test(`${provider}: linking protection preserves the other provider when linking the same verified email`, async () => {
    const otherProvider = provider === 'google' ? 'github' : 'google';
    const otherIdentity = randomUUID();
    const user = await linkingAccount({
      [`${otherProvider}Id`]: otherIdentity,
    });
    const before = await database.getRepository(User).findOneByOrFail({
      id: user.id,
    });
    const providerId = randomUUID();
    const login = await finish(provider, {
      id: providerId,
      email: user.email,
    });
    assert.equal(login.payload.sub, user.id);
    const stored = await database.getRepository(User).findOneByOrFail({
      id: user.id,
    });
    assert.equal(stored[`${provider}Id`], providerId);
    assert.equal(stored[`${otherProvider}Id`], otherIdentity);
    for (const field of [
      'firstName',
      'lastName',
      'failedLoginAttempts',
      'lockedUntil',
      'passwordResetToken',
      'passwordResetExpires',
    ]) {
      assert.deepEqual(stored[field], before[field]);
    }
    assert.equal(
      await database.getRepository(User).countBy({ email: user.email }),
      1,
    );
    assert.equal((await exchange(login)).status, 200);
  });

  test(`${provider}: linking protection maps a raced uniqueness conflict to 409 and preserves both accounts`, async (context) => {
    const repository = database.getRepository(User);
    const providerId = randomUUID();
    const owner = await linkingAccount({ [`${provider}Id`]: providerId });
    const user = await linkingAccount();
    const ownerSnapshot = await repository.findOneByOrFail({ id: owner.id });
    const userSnapshot = await repository.findOneByOrFail({ id: user.id });
    context.mock.method(
      application.app.get(UsersService),
      provider === 'google' ? 'findByGoogleId' : 'findByGithubId',
      async () => null,
    );
    const rejected = await callback(await begin(provider), {
      id: providerId,
      email: user.email,
    });
    assert.equal(rejected.status, 409);
    assert.equal(cookie(rejected, 'refresh_token'), undefined);
    assert.deepEqual(
      await repository.findOneByOrFail({ id: owner.id }),
      ownerSnapshot,
    );
    assert.deepEqual(
      await repository.findOneByOrFail({ id: user.id }),
      userSnapshot,
    );
    for (const account of [owner, user]) {
      assert.equal(
        await database.getRepository(Session).countBy({ userId: account.id }),
        0,
      );
      assert.equal(
        await database
          .getRepository(LoginHistory)
          .countBy({ userId: account.id }),
        0,
      );
    }
  });

  test(`${provider}: linking protection keeps unexpected database failures as 500 and permits a later retry`, async () => {
    const user = await linkingAccount();
    const repository = database.getRepository(User);
    const before = await repository.findOneByOrFail({ id: user.id });
    const providerId = randomUUID();
    await rejectLinkUpdate(async () => {
      const rejected = await callback(await begin(provider), {
        id: providerId,
        email: user.email,
      });
      assert.equal(rejected.status, 500);
      assert.equal((await rejected.json()).message, 'Internal server error');
      assert.equal(cookie(rejected, 'refresh_token'), undefined);
    });
    assert.deepEqual(await repository.findOneByOrFail({ id: user.id }), before);
    assert.equal(
      await database.getRepository(Session).countBy({ userId: user.id }),
      0,
    );
    const retry = await finish(provider, { id: providerId, email: user.email });
    assert.equal(retry.payload.sub, user.id);
    assert.equal((await exchange(retry)).status, 200);
  });
}

test('exchange rejects tampered, expired and wrong-type JWTs and invalid payload IDs', async () => {
  const login = await finish();
  const jwt = application.app.get(JwtService);
  const payload = {
    sub: login.payload.sub,
    sid: login.payload.sid,
    type: 'oauth_exchange',
  };
  const invalid = [
    'not-a-jwt',
    login.code.slice(0, -8) + 'invalid!',
    await jwt.signAsync(payload, {
      secret: testConfig.OAUTH_CODE_SECRET,
      expiresIn: -1,
    }),
    await jwt.signAsync(
      { ...payload, type: 'access' },
      { secret: testConfig.OAUTH_CODE_SECRET },
    ),
    await jwt.signAsync(
      { ...payload, sid: 'not-a-uuid' },
      { secret: testConfig.OAUTH_CODE_SECRET },
    ),
    await jwt.signAsync(
      { ...payload, sub: 42 },
      { secret: testConfig.OAUTH_CODE_SECRET },
    ),
    await jwt.signAsync(payload, {
      secret: testConfig.OAUTH_CODE_SECRET,
      algorithm: 'HS512',
    }),
  ];
  for (const code of invalid) {
    assert.equal((await exchange(login, { code })).status, 401);
    await assertCodeUnconsumed(login);
  }
  assert.equal((await exchange(login)).status, 200);
});

test('database code expiry, session expiry and revoked sessions block exchange', async () => {
  for (const mutation of [
    { oauthExchangeCodeExpiresAt: new Date(Date.now() - 1000) },
    { expiresAt: new Date(Date.now() - 1000) },
    { revokedAt: new Date() },
  ]) {
    const login = await finish();
    await database
      .getRepository(Session)
      .update({ id: login.payload.sid }, mutation);
    assert.equal((await exchange(login)).status, 401);
    await assertCodeUnconsumed(login);
  }
});

test('simultaneous exchanges return exactly one access token and clear both database code fields', async (context) => {
  const login = await finish();
  const service = application.app.get(SessionService);
  const consume = service.consumeOAuthExchangeCode.bind(service);
  let arrivals = 0;
  let release;
  const bothReady = new Promise((resolve) => {
    release = resolve;
  });
  context.mock.method(
    service,
    'consumeOAuthExchangeCode',
    async (consumption) => {
      if (++arrivals === 2) release();
      await bothReady;
      return consume(consumption);
    },
  );
  const responses = await Promise.all([exchange(login), exchange(login)]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 401],
  );
  const bodies = await Promise.all(
    responses.map((response) => response.json()),
  );
  assert.equal(
    bodies.filter((body) => typeof body.accessToken === 'string').length,
    1,
  );
  assert.equal((await session(login)).oauthExchangeCodeHash, null);
  assert.equal((await session(login)).oauthExchangeCodeExpiresAt, null);
});

test('revocation after initial session validation still blocks atomic code consumption', async (context) => {
  const login = await finish();
  const service = application.app.get(SessionService);
  const consume = service.consumeOAuthExchangeCode.bind(service);
  context.mock.method(
    service,
    'consumeOAuthExchangeCode',
    async (consumption) => {
      await service.revokeSession(consumption.sessionId);
      return consume(consumption);
    },
  );
  assert.equal((await exchange(login)).status, 401);
  await assertCodeUnconsumed(login);
});

test('a replacement exchange code invalidates the previous code for the same session', async () => {
  const login = await finish();
  const replacement = await application.app
    .get(AuthService)
    .createOAuthExchangeCode(login.payload.sub, login.payload.sid);
  assert.notEqual(replacement, login.code);
  assert.equal((await exchange(login)).status, 401);
  assert.equal((await exchange(login, { code: replacement })).status, 200);
});

test('unexpected database and signing errors propagate and leave the exchange code available for retry', async (context) => {
  const login = await finish();
  const auth = application.app.get(AuthService);
  const refreshToken = decodeURIComponent(login.refreshCookie.split('=')[1]);
  for (const [service, method] of [
    [application.app.get(UsersService), 'findById'],
    [application.app.get(JwtService), 'signAsync'],
  ]) {
    const failure = new Error(`Injected ${method} infrastructure failure`);
    const replacement = context.mock.method(service, method, async () => {
      throw failure;
    });
    await assert.rejects(
      auth.exchangeOAuthCode(login.code, refreshToken),
      (error) => error === failure,
    );
    await assertCodeUnconsumed(login);
    replacement.mock.restore();
  }
  assert.equal((await exchange(login)).status, 200);
});
