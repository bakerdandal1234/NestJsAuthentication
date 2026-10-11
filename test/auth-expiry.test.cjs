require('reflect-metadata');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const bcrypt = require('bcryptjs');
const { DataSource } = require('typeorm');
const { AuthService } = require('../src/auth/auth.service');
const { AuthSessionService } = require('../src/auth/auth-session.service');
const { UsersService } = require('../src/users/users.service');
const { OAuthStateService } = require('../src/auth/oauth-state.service');
const { OAuthState } = require('../src/auth/oauth-state.entity');
const {
  StaffOAuthChallengeService,
} = require('../src/auth/staff-oauth-challenge.service');
const {
  StaffOAuthChallenge,
} = require('../src/auth/staff-oauth-challenge.entity');
const { SessionService } = require('../src/sessions/session.service');
const { Session } = require('../src/sessions/entities/session.entity');
const { User } = require('../src/users/entities/user.entity');
const { LoginHistory } = require('../src/users/entities/login-history.entity');
const { createOAuthApp, testConfig } = require('./helpers/oauth-app.cjs');
const { startPostgres, stopPostgres } = require('./helpers/postgres.cjs');
const { currentTotpStep, totpAtStep } = require('./helpers/totp.cjs');

const digest = (token) => createHash('sha256').update(token).digest('hex');
const statusIs = (status) => (error) => error.getStatus?.() === status;
let postgres;
let application;
let database;
let auth;
let users;
let sessions;
let passwordHash;

before(
  async () => {
    postgres = await startPostgres();
    application = await createOAuthApp({ connection: postgres.connection });
    database = application.app.get(DataSource);
    auth = application.app.get(AuthService);
    users = application.app.get(UsersService);
    sessions = application.app.get(SessionService);
    passwordHash = await bcrypt.hash('ExpiryPassword!234', 4);
  },
  { timeout: 240_000 },
);

after(
  async () => {
    try {
      if (application) await application.app.close();
    } finally {
      if (postgres) await stopPostgres(postgres.directory);
    }
  },
  { timeout: 60_000 },
);

async function account() {
  const repository = database.getRepository(User);
  return repository.save(
    repository.create({
      email: `${randomUUID()}@example.test`,
      password: passwordHash,
      isEmailVerified: true,
    }),
  );
}

async function passwordSession() {
  const user = await account();
  return auth.login(user.email, 'ExpiryPassword!234', undefined, {});
}

async function stateFlow(provider) {
  const store = application.app.get(OAuthStateService).forProvider(provider);
  const cookies = {};
  const cleared = [];
  const request = {
    cookies,
    res: {
      cookie: (name, token) => {
        cookies[name] = token;
      },
      clearCookie: (name) => {
        cleared.push(name);
      },
    },
  };
  const token = await new Promise((resolve, reject) => {
    store.store(request, (error, state) =>
      error ? reject(error) : resolve(state),
    );
  });
  return { store, request, token, cleared };
}

function verifyState(flow) {
  return new Promise((resolve, reject) => {
    flow.store.verify(flow.request, flow.token, (error, verified) =>
      error ? reject(error) : resolve(verified),
    );
  });
}

const sessionRow = (login) => ({
  table: 'sessions',
  keyColumn: 'id',
  key: login.sessionId,
});
const stateRow = (flow) => ({
  table: 'oauth_states',
  keyColumn: 'stateHash',
  key: digest(flow.token),
});
const challengeRow = (token) => ({
  table: 'staff_oauth_challenges',
  keyColumn: 'tokenHash',
  key: digest(token),
});
const userRow = (userId) => ({ table: 'users', keyColumn: 'id', key: userId });
const storedUser = (userId) =>
  database.getRepository(User).findOneByOrFail({ id: userId });
const userSessions = (userId) =>
  database.getRepository(Session).findBy({ userId });

async function stagedOAuthVerification(context) {
  const user = await account();
  const setup = await auth.generateTwoFactorSecret(user.id);
  const step = await currentTotpStep();
  await auth.enableTwoFactor(user.id, totpAtStep(setup.secret, step - 1));
  const providerId = randomUUID();
  await database
    .getRepository(User)
    .update({ id: user.id }, { googleId: providerId });
  const challenged = await auth.loginWithOAuth(
    {
      provider: 'google',
      providerId,
      email: user.email,
      emailVerified: true,
    },
    {},
  );
  assert.equal(challenged.twoFactorRequired, true);
  const issuer = application.app.get(AuthSessionService);
  const issue = issuer.issueTokens.bind(issuer);
  let proceed;
  let reached;
  const resume = new Promise((resolve) => {
    proceed = resolve;
  });
  const ready = new Promise((resolve) => {
    reached = resolve;
  });
  context.mock.method(
    issuer,
    'issueTokens',
    async (verifiedUser, sessionId) => {
      const tokens = await issue(verifiedUser, sessionId);
      reached();
      await resume;
      return tokens;
    },
  );
  const code = totpAtStep(setup.secret, step);
  const completion = auth.verifyOAuthTwoFactor(challenged.challenge, code, {});
  completion.catch(() => {});
  await Promise.race([ready, completion]);
  return { user, token: challenged.challenge, step, code, completion, proceed };
}

async function verificationAccount() {
  const user = await account();
  const token = randomUUID();
  await database.getRepository(User).update(
    { id: user.id },
    {
      isEmailVerified: false,
      emailVerificationToken: token,
      emailVerificationExpires: new Date(Date.now() + 60_000),
    },
  );
  return { user, token, row: userRow(user.id) };
}

async function resetAccount() {
  const login = await passwordSession();
  const token = randomUUID();
  await database.getRepository(User).update(
    { id: login.userId },
    {
      passwordResetToken: token,
      passwordResetExpires: new Date(Date.now() + 60_000),
      failedLoginAttempts: 4,
      lockedUntil: new Date(Date.now() + 60_000),
    },
  );
  const replacementHash = await bcrypt.hash('ReplacementPassword!234', 4);
  return { login, token, replacementHash, row: userRow(login.userId) };
}

// Cases: expiry during an unchanged row lock, an unexpired lock wait, rollback and concurrent consumers.
async function expireSoon(row, column = 'expiresAt') {
  await database.query(
    `UPDATE "${row.table}" SET "${column}" = clock_timestamp() + INTERVAL '3 seconds'
    WHERE "${row.keyColumn}" = $1`,
    [row.key],
  );
}

async function waitForLock(table) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [activity] = await database.query(
      `SELECT COUNT(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
      AND query LIKE $1`,
      [`%${table}%`],
    );
    if (activity.waiting > 0) return;
    if (Date.now() >= deadline)
      assert.fail(`Operation did not wait for the ${table} row lock`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitUntilExpired(row, column = 'expiresAt') {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [clock] = await database.query(
      `SELECT "${column}" <= clock_timestamp() AS expired
      FROM "${row.table}" WHERE "${row.keyColumn}" = $1`,
      [row.key],
    );
    if (clock.expired) return;
    if (Date.now() >= deadline) assert.fail('The test row did not expire');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function lockedOperation(row, operation, whileLocked = async () => {}) {
  const locker = database.createQueryRunner();
  await locker.connect();
  await locker.startTransaction();
  let pending;
  try {
    await locker.query(
      `SELECT "${row.keyColumn}" FROM "${row.table}"
      WHERE "${row.keyColumn}" = $1 FOR UPDATE`,
      [row.key],
    );
    pending = Promise.resolve().then(operation);
    // Attach immediately; the assertion below still receives the original rejection.
    pending.catch(() => {});
    await waitForLock(row.table);
    await whileLocked(locker);
  } finally {
    // Expiry cases release an unchanged row; replacement cases commit their mutation explicitly.
    if (locker.isTransactionActive) await locker.rollbackTransaction();
    await locker.release();
  }
  return pending;
}

function refresh(login) {
  return fetch(`${application.baseUrl}/v1/auth/refresh`, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: {
      cookie: `refresh_token=${login.refreshToken}`,
      'x-csrf-token': auth.computeCsrfToken(login.sessionId),
    },
  });
}

function exchange(login, code) {
  return fetch(`${application.baseUrl}/v1/auth/oauth/exchange`, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: {
      'content-type': 'application/json',
      origin: testConfig.FRONTEND_URL,
      cookie: `refresh_token=${login.refreshToken}`,
    },
    body: JSON.stringify({ code }),
  });
}

async function twoFactorChallenge() {
  const user = await account();
  const service = application.app.get(StaffOAuthChallengeService);
  const token = await service.create(user.id, 'isolated-expiry-test-secret');
  return { service, token, row: challengeRow(token) };
}

async function failWrite(table, event, operation) {
  await database.query(`CREATE FUNCTION reject_expiry_write() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'forced expiry write failure'; END; $$ LANGUAGE plpgsql`);
  await database.query(`CREATE TRIGGER reject_expiry_write BEFORE ${event} ON ${table}
    FOR EACH ROW EXECUTE FUNCTION reject_expiry_write()`);
  try {
    await operation();
  } finally {
    await database.query(`DROP TRIGGER reject_expiry_write ON ${table}`);
    await database.query('DROP FUNCTION reject_expiry_write()');
  }
}

for (const provider of ['google', 'github']) {
  test(`expiry after row lock: ${provider} state cannot be consumed after expiring while waiting`, async () => {
    const flow = await stateFlow(provider);
    const row = stateRow(flow);
    await expireSoon(row);
    await assert.rejects(
      lockedOperation(
        row,
        () => verifyState(flow),
        () => waitUntilExpired(row),
      ),
      statusIs(401),
    );
    assert.ok(
      await database
        .getRepository(OAuthState)
        .findOneBy({ stateHash: row.key }),
    );
    assert.deepEqual(flow.cleared, []);
  });
}

test('expiry after row lock: HTTP refresh cannot issue tokens from a session that expired while waiting', async () => {
  const login = await passwordSession();
  const row = sessionRow(login);
  await expireSoon(row);
  const response = await lockedOperation(
    row,
    () => refresh(login),
    () => waitUntilExpired(row),
  );
  assert.equal(response.status, 401);
  assert.equal(response.headers.getSetCookie().length, 0);
  assert.equal((await response.json()).accessToken, undefined);
  assert.equal(
    (await sessions.findById(login.sessionId)).refreshTokenHash,
    digest(login.refreshToken),
  );
});

test('expiry after row lock: an expired OAuth 2FA challenge does not consume a verification attempt', async () => {
  const challenge = await twoFactorChallenge();
  await expireSoon(challenge.row);
  await assert.rejects(
    lockedOperation(
      challenge.row,
      () => challenge.service.attempt(challenge.token),
      () => waitUntilExpired(challenge.row),
    ),
    statusIs(401),
  );
  assert.equal(
    (
      await database
        .getRepository(StaffOAuthChallenge)
        .findOneByOrFail({ tokenHash: challenge.row.key })
    ).attempts,
    0,
  );
});

test('expiry after row lock: an exchange code cannot be stored on a session that expired while waiting', async () => {
  const login = await passwordSession();
  const row = sessionRow(login);
  await expireSoon(row);
  await assert.rejects(
    lockedOperation(
      row,
      () => auth.createOAuthExchangeCode(login.userId, login.sessionId),
      () => waitUntilExpired(row),
    ),
    statusIs(401),
  );
  const stored = await sessions.findById(login.sessionId);
  assert.equal(stored.oauthExchangeCodeHash, null);
  assert.equal(stored.oauthExchangeCodeExpiresAt, null);
});

test('expiry after row lock: a replacement exchange code that expired while waiting is not stored', async () => {
  const login = await passwordSession();
  const oldCode = await auth.createOAuthExchangeCode(
    login.userId,
    login.sessionId,
  );
  const row = sessionRow(login);
  await expireSoon(row, 'oauthExchangeCodeExpiresAt');
  const previous = await sessions.findById(login.sessionId);
  await assert.rejects(
    lockedOperation(
      row,
      () =>
        sessions.storeOAuthExchangeCode(
          login.sessionId,
          login.userId,
          digest(randomUUID()),
          previous.oauthExchangeCodeExpiresAt,
        ),
      () => waitUntilExpired(row, 'oauthExchangeCodeExpiresAt'),
    ),
    statusIs(401),
  );
  const stored = await sessions.findById(login.sessionId);
  assert.equal(stored.oauthExchangeCodeHash, digest(oldCode));
  assert.deepEqual(
    stored.oauthExchangeCodeExpiresAt,
    previous.oauthExchangeCodeExpiresAt,
  );
});

for (const column of ['oauthExchangeCodeExpiresAt', 'expiresAt']) {
  test(`expiry after row lock: HTTP OAuth exchange rechecks ${column} after waiting`, async () => {
    const login = await passwordSession();
    const code = await auth.createOAuthExchangeCode(
      login.userId,
      login.sessionId,
    );
    const row = sessionRow(login);
    await expireSoon(row, column);
    const previous = await sessions.findById(login.sessionId);
    const response = await lockedOperation(
      row,
      () => exchange(login, code),
      () => waitUntilExpired(row, column),
    );
    assert.equal(response.status, 401);
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.equal((await response.json()).accessToken, undefined);
    assert.deepEqual(await sessions.findById(login.sessionId), previous);
  });
}

test('expiry after row lock: an unexpired state is consumed once after waiting and its cookie is cleared after commit', async () => {
  const flow = await stateFlow('google');
  assert.equal(
    await lockedOperation(stateRow(flow), () => verifyState(flow)),
    true,
  );
  assert.equal(
    await database
      .getRepository(OAuthState)
      .findOneBy({ stateHash: digest(flow.token) }),
    null,
  );
  assert.deepEqual(flow.cleared, ['oauth_google_state']);
  await assert.rejects(verifyState(flow), statusIs(401));
  assert.deepEqual(flow.cleared, ['oauth_google_state']);
});

test('expiry after row lock: an unexpired challenge increments its attempts exactly once after waiting', async () => {
  const challenge = await twoFactorChallenge();
  const attempted = await lockedOperation(challenge.row, () =>
    challenge.service.attempt(challenge.token),
  );
  assert.equal(attempted.attempts, 1);
  assert.equal(
    (
      await database
        .getRepository(StaffOAuthChallenge)
        .findOneByOrFail({ tokenHash: challenge.row.key })
    ).attempts,
    1,
  );
});

test('expiry after row lock: an unexpired refresh rotates once and records database time after the wait', async () => {
  const login = await passwordSession();
  const newHash = digest(randomUUID());
  let afterWait;
  const rotated = await lockedOperation(
    sessionRow(login),
    () =>
      sessions.rotateRefreshTokenIfMatches(
        login.sessionId,
        digest(login.refreshToken),
        newHash,
      ),
    async () => {
      [afterWait] = await database.query('SELECT clock_timestamp() AS instant');
    },
  );
  assert.equal(rotated, true);
  const stored = await sessions.findById(login.sessionId);
  assert.equal(stored.refreshTokenHash, newHash);
  assert.ok(stored.lastUsedAt >= afterWait.instant);
  assert.equal(
    await sessions.rotateRefreshTokenIfMatches(
      login.sessionId,
      digest(login.refreshToken),
      digest(randomUUID()),
    ),
    false,
  );
});

test('expiry after row lock: concurrent challenge attempts still enforce the five-attempt limit', async () => {
  const challenge = await twoFactorChallenge();
  const attempts = await Promise.allSettled(
    Array.from({ length: 6 }, () => challenge.service.attempt(challenge.token)),
  );
  const accepted = attempts.filter((attempt) => attempt.status === 'fulfilled');
  const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
  assert.deepEqual(
    accepted.map((attempt) => attempt.value.attempts).sort(),
    [1, 2, 3, 4, 5],
  );
  assert.equal(rejected.length, 1);
  assert.ok(statusIs(401)(rejected[0].reason));
  assert.equal(
    (
      await database
        .getRepository(StaffOAuthChallenge)
        .findOneByOrFail({ tokenHash: challenge.row.key })
    ).attempts,
    5,
  );
});

test('expiry after row lock: concurrent refreshes still accept one request and revoke the session after reuse', async () => {
  const login = await passwordSession();
  const csrf = auth.computeCsrfToken(login.sessionId);
  const attempts = await Promise.allSettled([
    auth.refreshTokens(login.refreshToken, csrf),
    auth.refreshTokens(login.refreshToken, csrf),
  ]);
  const accepted = attempts.filter((attempt) => attempt.status === 'fulfilled');
  const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(statusIs(401)(rejected[0].reason));
  assert.ok((await sessions.findById(login.sessionId)).revokedAt);
  const profile = await fetch(`${application.baseUrl}/v1/users/me`, {
    headers: { authorization: `Bearer ${accepted[0].value.accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(profile.status, 401);
});

test('expiry after row lock: failed state deletion rolls back, keeps the cookie and releases the lock for retry', async () => {
  const flow = await stateFlow('google');
  await failWrite('oauth_states', 'DELETE', async () => {
    await assert.rejects(verifyState(flow), /forced expiry write failure/);
    assert.ok(
      await database
        .getRepository(OAuthState)
        .findOneBy({ stateHash: digest(flow.token) }),
    );
    assert.deepEqual(flow.cleared, []);
  });
  assert.equal(await verifyState(flow), true);
});

test('expiry after row lock: failed attempt increment rolls back and releases the challenge lock for retry', async () => {
  const challenge = await twoFactorChallenge();
  await failWrite('staff_oauth_challenges', 'UPDATE', async () => {
    await assert.rejects(
      challenge.service.attempt(challenge.token),
      /forced expiry write failure/,
    );
    assert.equal(
      (
        await database
          .getRepository(StaffOAuthChallenge)
          .findOneByOrFail({ tokenHash: challenge.row.key })
      ).attempts,
      0,
    );
  });
  assert.equal((await challenge.service.attempt(challenge.token)).attempts, 1);
});

for (const operation of ['exchange', 'store', 'rotate']) {
  test(`expiry after row lock: failed session ${operation} rolls back and releases its lock for retry`, async () => {
    const login = await passwordSession();
    const code = await auth.createOAuthExchangeCode(
      login.userId,
      login.sessionId,
    );
    const previous = await sessions.findById(login.sessionId);
    const execute = {
      exchange: () => auth.exchangeOAuthCode(code, login.refreshToken),
      store: () => auth.createOAuthExchangeCode(login.userId, login.sessionId),
      rotate: () =>
        auth.refreshTokens(
          login.refreshToken,
          auth.computeCsrfToken(login.sessionId),
        ),
    }[operation];
    await failWrite('sessions', 'UPDATE', async () => {
      await assert.rejects(execute(), /forced expiry write failure/);
      assert.deepEqual(await sessions.findById(login.sessionId), previous);
    });
    assert.ok(await execute());
  });
}

// Cases: unchanged locks, replacement during waits, single consumption, rollback and late OAuth challenge expiry.
test('user token expiry: email verification rejects a token that expires while waiting for the user lock', async () => {
  const { user, token, row } = await verificationAccount();
  await expireSoon(row, 'emailVerificationExpires');
  const previous = await storedUser(user.id);
  const response = await lockedOperation(
    row,
    () =>
      fetch(`${application.baseUrl}/v1/auth/verify-email?token=${token}`, {
        signal: AbortSignal.timeout(15_000),
      }),
    () => waitUntilExpired(row, 'emailVerificationExpires'),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await storedUser(user.id), previous);
});

test('user token expiry: password reset rejects a token that expires while waiting for the user lock', async () => {
  const { login, token, row, replacementHash } = await resetAccount();
  await expireSoon(row, 'passwordResetExpires');
  const previous = await storedUser(login.userId);
  const previousSessions = await userSessions(login.userId);
  await assert.rejects(
    lockedOperation(
      row,
      () =>
        users.resetPasswordAndRevokeSessions(
          login.userId,
          token,
          replacementHash,
        ),
      () => waitUntilExpired(row, 'passwordResetExpires'),
    ),
    statusIs(400),
  );
  assert.deepEqual(await storedUser(login.userId), previous);
  assert.deepEqual(await userSessions(login.userId), previousSessions);
});

test(
  'user token expiry: OAuth completion rejects a challenge that expires during a challenge-row lock wait',
  { timeout: 25_000 },
  async (context) => {
    const flow = await stagedOAuthVerification(context);
    try {
      const row = challengeRow(flow.token);
      await expireSoon(row);
      const previous = await storedUser(flow.user.id);
      await assert.rejects(
        lockedOperation(
          row,
          () => {
            flow.proceed();
            return flow.completion;
          },
          () => waitUntilExpired(row),
        ),
        statusIs(401),
      );
      assert.deepEqual(await storedUser(flow.user.id), previous);
      assert.equal((await userSessions(flow.user.id)).length, 0);
      assert.equal(
        (
          await database
            .getRepository(LoginHistory)
            .findBy({ userId: flow.user.id, success: true })
        ).length,
        0,
      );
      const challenge = await database
        .getRepository(StaffOAuthChallenge)
        .findOneByOrFail({ tokenHash: row.key });
      assert.equal(challenge.attempts, 1);
    } finally {
      flow.proceed();
      await flow.completion.catch(() => {});
    }
  },
);

test('user token expiry: an unexpired verification token works once after a user-row lock wait', async () => {
  const flow = await verificationAccount();
  const previous = await storedUser(flow.user.id);
  await lockedOperation(flow.row, () => auth.verifyEmail(flow.token));
  const verified = await storedUser(flow.user.id);
  assert.equal(verified.isEmailVerified, true);
  assert.equal(verified.emailVerificationToken, null);
  assert.equal(verified.emailVerificationExpires, null);
  assert.equal(verified.password, previous.password);
  await assert.rejects(auth.verifyEmail(flow.token), statusIs(400));
});

test('user token expiry: an unexpired reset token changes the password and revokes only its user sessions after waiting', async () => {
  const flow = await resetAccount();
  const other = await passwordSession();
  const otherSessions = await userSessions(other.userId);
  await lockedOperation(flow.row, () =>
    users.resetPasswordAndRevokeSessions(
      flow.login.userId,
      flow.token,
      flow.replacementHash,
    ),
  );
  const reset = await storedUser(flow.login.userId);
  assert.equal(reset.password, flow.replacementHash);
  assert.equal(reset.passwordResetToken, null);
  assert.equal(reset.passwordResetExpires, null);
  assert.equal(reset.failedLoginAttempts, 0);
  assert.equal(reset.lockedUntil, null);
  assert.ok(
    (await userSessions(flow.login.userId)).every(
      (session) => session.revokedAt,
    ),
  );
  assert.deepEqual(await userSessions(other.userId), otherSessions);
  await assert.rejects(
    users.resetPasswordAndRevokeSessions(
      flow.login.userId,
      flow.token,
      passwordHash,
    ),
    statusIs(400),
  );
  assert.ok(
    (await auth.login(reset.email, 'ReplacementPassword!234', undefined, {}))
      .accessToken,
  );
});

test(
  'user token expiry: an unexpired OAuth challenge completes once after a challenge-row lock wait',
  { timeout: 25_000 },
  async (context) => {
    const flow = await stagedOAuthVerification(context);
    try {
      const completed = await lockedOperation(challengeRow(flow.token), () => {
        flow.proceed();
        return flow.completion;
      });
      assert.ok(completed.accessToken);
      assert.equal((await userSessions(flow.user.id)).length, 1);
      assert.equal(
        (
          await database
            .getRepository(LoginHistory)
            .findBy({ userId: flow.user.id, success: true })
        ).length,
        1,
      );
      assert.equal(
        (await storedUser(flow.user.id)).twoFactorLastUsedStep,
        flow.step,
      );
      assert.equal(
        await database
          .getRepository(StaffOAuthChallenge)
          .findOneBy({ tokenHash: digest(flow.token) }),
        null,
      );
      await assert.rejects(
        auth.verifyOAuthTwoFactor(flow.token, flow.code, {}),
        statusIs(401),
      );
      assert.equal((await userSessions(flow.user.id)).length, 1);
    } finally {
      flow.proceed();
      await flow.completion.catch(() => {});
    }
  },
);

test('user token expiry: replacing a verification token while its user is locked preserves the replacement', async () => {
  const flow = await verificationAccount();
  const replacement = randomUUID();
  await assert.rejects(
    lockedOperation(
      flow.row,
      () => auth.verifyEmail(flow.token),
      async (locker) => {
        await locker.query(
          'UPDATE users SET "emailVerificationToken" = $2, "emailVerificationExpires" = clock_timestamp() + INTERVAL \'60 seconds\' WHERE id = $1',
          [flow.user.id, replacement],
        );
        await locker.commitTransaction();
      },
    ),
    statusIs(400),
  );
  const unchanged = await storedUser(flow.user.id);
  assert.equal(unchanged.isEmailVerified, false);
  assert.equal(unchanged.emailVerificationToken, replacement);
  await auth.verifyEmail(replacement);
  assert.equal((await storedUser(flow.user.id)).isEmailVerified, true);
});

test('user token expiry: replacing a reset token while its user is locked preserves the password, sessions and replacement', async () => {
  const flow = await resetAccount();
  const replacement = randomUUID();
  const previousSessions = await userSessions(flow.login.userId);
  await assert.rejects(
    lockedOperation(
      flow.row,
      () =>
        users.resetPasswordAndRevokeSessions(
          flow.login.userId,
          flow.token,
          flow.replacementHash,
        ),
      async (locker) => {
        await locker.query(
          'UPDATE users SET "passwordResetToken" = $2, "passwordResetExpires" = clock_timestamp() + INTERVAL \'60 seconds\' WHERE id = $1',
          [flow.login.userId, replacement],
        );
        await locker.commitTransaction();
      },
    ),
    statusIs(400),
  );
  const unchanged = await storedUser(flow.login.userId);
  assert.equal(unchanged.password, passwordHash);
  assert.equal(unchanged.passwordResetToken, replacement);
  assert.equal(unchanged.failedLoginAttempts, 4);
  assert.ok(unchanged.lockedUntil);
  assert.deepEqual(await userSessions(flow.login.userId), previousSessions);
  await users.resetPasswordAndRevokeSessions(
    flow.login.userId,
    replacement,
    flow.replacementHash,
  );
  assert.equal(
    (await storedUser(flow.login.userId)).password,
    flow.replacementHash,
  );
});

test('user token expiry: verification write failure rolls back the token and releases the user lock for retry', async () => {
  const flow = await verificationAccount();
  const previous = await storedUser(flow.user.id);
  await failWrite('users', 'UPDATE', async () => {
    await assert.rejects(
      lockedOperation(flow.row, () => auth.verifyEmail(flow.token)),
      /forced expiry write failure/,
    );
    assert.deepEqual(await storedUser(flow.user.id), previous);
  });
  await auth.verifyEmail(flow.token);
  assert.equal((await storedUser(flow.user.id)).emailVerificationToken, null);
});

test('user token expiry: HTTP password reset rechecks expiry after hashing and a user-row lock wait', async (context) => {
  const flow = await resetAccount();
  const reset = users.resetPasswordAndRevokeSessions.bind(users);
  let previous;
  const previousSessions = await userSessions(flow.login.userId);
  context.mock.method(
    users,
    'resetPasswordAndRevokeSessions',
    async (userId, token, replacementHash) => {
      // Start the short deadline after bcrypt has completed, before the real transaction waits.
      await expireSoon(flow.row, 'passwordResetExpires');
      previous = await storedUser(userId);
      return lockedOperation(
        flow.row,
        () => reset(userId, token, replacementHash),
        () => waitUntilExpired(flow.row, 'passwordResetExpires'),
      );
    },
  );
  const response = await fetch(
    `${application.baseUrl}/v1/auth/reset-password`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: flow.token,
        newPassword: 'ReplacementPassword!234',
      }),
    },
  );
  assert.equal(response.status, 400);
  assert.equal(response.headers.getSetCookie().length, 0);
  assert.deepEqual(await storedUser(flow.login.userId), previous);
  assert.deepEqual(await userSessions(flow.login.userId), previousSessions);
});

test(
  'user token expiry: OAuth challenge deletion failure rolls back the final transaction and permits retry',
  { timeout: 25_000 },
  async (context) => {
    const flow = await stagedOAuthVerification(context);
    try {
      const previous = await storedUser(flow.user.id);
      await failWrite('staff_oauth_challenges', 'DELETE', async () => {
        await assert.rejects(
          lockedOperation(challengeRow(flow.token), () => {
            flow.proceed();
            return flow.completion;
          }),
          /forced expiry write failure/,
        );
        assert.deepEqual(await storedUser(flow.user.id), previous);
        assert.equal((await userSessions(flow.user.id)).length, 0);
        assert.equal(
          (
            await database
              .getRepository(LoginHistory)
              .findBy({ userId: flow.user.id, success: true })
          ).length,
          0,
        );
        assert.equal(
          (
            await database
              .getRepository(StaffOAuthChallenge)
              .findOneByOrFail({ tokenHash: digest(flow.token) })
          ).attempts,
          1,
        );
      });
      const completed = await auth.verifyOAuthTwoFactor(
        flow.token,
        flow.code,
        {},
      );
      assert.ok(completed.accessToken);
      assert.equal((await userSessions(flow.user.id)).length, 1);
      assert.equal(
        (await storedUser(flow.user.id)).twoFactorLastUsedStep,
        flow.step,
      );
    } finally {
      flow.proceed();
      await flow.completion.catch(() => {});
    }
  },
);
