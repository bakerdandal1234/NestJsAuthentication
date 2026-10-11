require('reflect-metadata');
const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const { DataSource } = require('typeorm');
const { JwtService } = require('@nestjs/jwt');
const { AuthService } = require('../src/auth/auth.service');
const { AuthSessionService } = require('../src/auth/auth-session.service');
const {
  StaffOAuthChallenge,
} = require('../src/auth/staff-oauth-challenge.entity');
const { UsersService } = require('../src/users/users.service');
const { User } = require('../src/users/entities/user.entity');
const { LoginHistory } = require('../src/users/entities/login-history.entity');
const { Session } = require('../src/sessions/entities/session.entity');
const { SessionService } = require('../src/sessions/session.service');
const { MailService, MailDeliveryError } = require('../src/mail/mail.service');
const { createOAuthApp, testConfig } = require('./helpers/oauth-app.cjs');
const { databaseOptions } = require('../src/config/database-options');
const { startPostgres, stopPostgres } = require('./helpers/postgres.cjs');
const { currentTotpStep, totpAtStep } = require('./helpers/totp.cjs');

const oldPassword = 'OldPassword!234';
const newPassword = 'NewPassword!234';
const digest = (token) => createHash('sha256').update(token).digest('hex');
let postgres;
let application;
let database;
let auth;
let users;
let sessions;
let mail;
let jwt;
let originalHash;

before(
  async () => {
    postgres = await startPostgres();
    application = await createOAuthApp({ connection: postgres.connection });
    database = application.app.get(DataSource);
    auth = application.app.get(AuthService);
    users = application.app.get(UsersService);
    sessions = application.app.get(SessionService);
    mail = application.app.get(MailService);
    jwt = application.app.get(JwtService);
    originalHash = await bcrypt.hash(oldPassword, 4);
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

async function account(overrides = {}, sessionCount = 2) {
  const repository = database.getRepository(User);
  const user = await repository.save(
    repository.create({
      email: `${randomUUID()}@example.test`,
      password: originalHash,
      isEmailVerified: true,
      failedLoginAttempts: 2,
      lockedUntil: new Date(Date.now() - 1_000),
      emailVerificationToken: randomBytes(32).toString('hex'),
      emailVerificationExpires: new Date(Date.now() + 60_000),
      passwordResetToken: randomBytes(32).toString('hex'),
      passwordResetExpires: new Date(Date.now() + 60_000),
      ...overrides,
    }),
  );
  const sessionRepository = database.getRepository(Session);
  for (let index = 0; index < sessionCount; index += 1) {
    await sessionRepository.save(
      sessionRepository.create({
        userId: user.id,
        refreshTokenHash: randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
  }
  return user;
}

const storedUser = (user) =>
  database.getRepository(User).findOneByOrFail({ id: user.id });
const userSessions = (user) =>
  database.getRepository(Session).findBy({ userId: user.id });
const history = (user) =>
  database.getRepository(LoginHistory).findBy({ userId: user.id });
const statusIs = (status) => (error) => error.getStatus?.() === status;

// Cases: new/reused/older steps, concurrent consumers, rollback, expiry after a lock wait and secret replacement.
async function replayAccount() {
  const user = await account({ failedLoginAttempts: 0, lockedUntil: null }, 0);
  const setup = await auth.generateTwoFactorSecret(user.id);
  const step = await currentTotpStep();
  await auth.enableTwoFactor(user.id, totpAtStep(setup.secret, step - 1));
  return { user, secret: setup.secret, step };
}

async function replayChallenge(flow) {
  const stored = await storedUser(flow.user);
  const providerId = stored.googleId ?? randomUUID();
  if (!stored.googleId)
    await database
      .getRepository(User)
      .update({ id: flow.user.id }, { googleId: providerId });
  const challenged = await auth.loginWithOAuth(
    {
      provider: 'google',
      providerId,
      email: flow.user.email,
      emailVerified: true,
    },
    {},
  );
  assert.equal(challenged.twoFactorRequired, true);
  return challenged.challenge;
}

function synchronizeTokenIssuers(context) {
  const issuer = application.app.get(AuthSessionService);
  const issue = issuer.issueTokens.bind(issuer);
  let arrivals = 0;
  let release;
  const rendezvous = new Promise((resolve) => {
    release = resolve;
  });
  context.mock.method(issuer, 'issueTokens', async (user, sessionId) => {
    const tokens = await issue(user, sessionId);
    if (++arrivals === 2) release();
    await rendezvous;
    return tokens;
  });
  return release;
}

async function request(path, options = {}) {
  return fetch(`${application.baseUrl}/v1${path}`, {
    signal: AbortSignal.timeout(15_000),
    ...options,
  });
}

async function failWrite(table, event, operation) {
  await database.query(`CREATE FUNCTION reject_security_write() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'forced security write failure'; END; $$ LANGUAGE plpgsql`);
  await database.query(`CREATE TRIGGER reject_security_write BEFORE ${event} ON ${table}
    FOR EACH ROW EXECUTE FUNCTION reject_security_write()`);
  try {
    await operation();
  } finally {
    await database.query(`DROP TRIGGER reject_security_write ON ${table}`);
    await database.query('DROP FUNCTION reject_security_write()');
  }
}

test('email verification clears token and expiry in PostgreSQL and cannot be replayed through HTTP', async () => {
  const user = await account({ isEmailVerified: false });
  const path = `/auth/verify-email?token=${user.emailVerificationToken}`;
  const response = await request(path);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    message: 'Email verified successfully',
  });
  const verified = await storedUser(user);
  assert.equal(verified.isEmailVerified, true);
  assert.equal(verified.emailVerificationToken, null);
  assert.equal(verified.emailVerificationExpires, null);
  assert.equal(verified.password, originalHash);
  assert.equal((await request(path)).status, 400);
});

test('simultaneous verification requests consume a token exactly once', async () => {
  const user = await account({ isEmailVerified: false });
  const attempts = await Promise.allSettled([
    auth.verifyEmail(user.emailVerificationToken),
    auth.verifyEmail(user.emailVerificationToken),
  ]);
  assert.equal(
    attempts.filter((attempt) => attempt.status === 'fulfilled').length,
    1,
  );
  const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.ok(statusIs(400)(rejected[0].reason));
});

test('empty, unknown, expired and missing-expiry verification tokens cannot verify a user', async () => {
  for (const token of ['', randomBytes(32).toString('hex')]) {
    await assert.rejects(auth.verifyEmail(token), statusIs(400));
  }
  for (const expiry of [null, new Date(Date.now() - 1_000)]) {
    const user = await account({
      isEmailVerified: false,
      emailVerificationExpires: expiry,
    });
    await assert.rejects(
      auth.verifyEmail(user.emailVerificationToken),
      statusIs(400),
    );
    const unchanged = await storedUser(user);
    assert.equal(unchanged.isEmailVerified, false);
    assert.equal(unchanged.emailVerificationToken, user.emailVerificationToken);
  }
});

test('change-password clears lock and outstanding reset token and revokes only this user sessions', async () => {
  const user = await account({ lockedUntil: new Date(Date.now() + 60_000) });
  const other = await account();
  assert.deepEqual(
    await auth.changePassword(user.id, oldPassword, newPassword),
    {
      message: 'Password changed successfully. Please log in again.',
    },
  );
  const changed = await storedUser(user);
  assert.equal(await bcrypt.compare(newPassword, changed.password), true);
  assert.equal(changed.failedLoginAttempts, 0);
  assert.equal(changed.lockedUntil, null);
  assert.equal(changed.passwordResetToken, null);
  assert.equal(changed.passwordResetExpires, null);
  assert.equal(changed.emailVerificationToken, user.emailVerificationToken);
  assert.ok(
    (await userSessions(user)).every(
      (session) => session.revokedAt instanceof Date,
    ),
  );
  assert.ok(
    (await userSessions(other)).every((session) => session.revokedAt === null),
  );
  await assert.rejects(
    auth.resetPassword(user.passwordResetToken, 'StaleReset!234'),
    statusIs(400),
  );
});

test('wrong current password and OAuth-only accounts cannot change password or revoke sessions', async () => {
  for (const password of [originalHash, null]) {
    const user = await account({ password });
    await assert.rejects(
      auth.changePassword(user.id, 'Incorrect!234', newPassword),
      statusIs(400),
    );
    assert.equal((await storedUser(user)).password, password);
    assert.ok(
      (await userSessions(user)).every((session) => session.revokedAt === null),
    );
  }
});

test('concurrent changes using the same current password permit exactly one commit', async (context) => {
  const user = await account();
  const find = users.findById.bind(users);
  let reads = 0;
  let release;
  const bothRead = new Promise((resolve) => {
    release = resolve;
  });
  context.mock.method(users, 'findById', async (id) => {
    const snapshot = await find(id);
    if (++reads === 2) release();
    await bothRead;
    return snapshot;
  });
  const passwords = [newPassword, 'ConcurrentPassword!234'];
  const attempts = await Promise.allSettled(
    passwords.map((password) =>
      auth.changePassword(user.id, oldPassword, password),
    ),
  );
  assert.equal(
    attempts.filter((attempt) => attempt.status === 'fulfilled').length,
    1,
  );
  const loser = attempts.find((attempt) => attempt.status === 'rejected');
  assert.ok(statusIs(400)(loser.reason));
  const winner = attempts.findIndex(
    (attempt) => attempt.status === 'fulfilled',
  );
  assert.equal(
    await bcrypt.compare(passwords[winner], (await storedUser(user)).password),
    true,
  );
});

test('session revocation failure rolls back a password change and permits a later retry', async () => {
  const user = await account();
  await failWrite('sessions', 'UPDATE', async () => {
    await assert.rejects(
      auth.changePassword(user.id, oldPassword, newPassword),
      /forced security write failure/,
    );
  });
  const unchanged = await storedUser(user);
  assert.equal(unchanged.password, originalHash);
  assert.equal(unchanged.passwordResetToken, user.passwordResetToken);
  assert.equal(unchanged.lockedUntil.getTime(), user.lockedUntil.getTime());
  assert.equal(unchanged.failedLoginAttempts, user.failedLoginAttempts);
  assert.ok(
    (await userSessions(user)).every((session) => session.revokedAt === null),
  );
  await auth.changePassword(user.id, oldPassword, newPassword);
});

test('simultaneous bad passwords preserve increments, lock at five and send exactly one notice after commit', async (context) => {
  const user = await account({ failedLoginAttempts: 0, lockedUntil: null }, 0);
  const find = users.findByEmail.bind(users);
  let reads = 0;
  let release;
  const allRead = new Promise((resolve) => {
    release = resolve;
  });
  context.mock.method(users, 'findByEmail', async (email) => {
    const snapshot = await find(email);
    if (++reads === 8) release();
    await allRead;
    return snapshot;
  });
  const notices = context.mock.method(
    mail,
    'sendAccountLockedNotice',
    async (email) => {
      assert.equal(email, user.email);
      const locked = await storedUser(user);
      assert.ok(locked.lockedUntil.getTime() > Date.now());
      assert.equal(locked.failedLoginAttempts, 0);
      assert.ok((await history(user)).length >= 5);
    },
  );
  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      auth.login(user.email, 'Incorrect!234', undefined, {}),
    ),
  );
  assert.ok(
    attempts.every(
      (attempt) =>
        attempt.status === 'rejected' && statusIs(401)(attempt.reason),
    ),
  );
  assert.equal(notices.mock.callCount(), 1);
  assert.equal((await storedUser(user)).failedLoginAttempts, 0);
  assert.equal((await history(user)).length, 8);
  assert.equal((await userSessions(user)).length, 0);
});

test('audit insert failure rolls back the failed-attempt increment and suppresses lock notice', async (context) => {
  const user = await account({ failedLoginAttempts: 4, lockedUntil: null }, 0);
  const notices = context.mock.method(
    mail,
    'sendAccountLockedNotice',
    async () => {},
  );
  await failWrite('login_history', 'INSERT', async () => {
    await assert.rejects(
      auth.login(user.email, 'Incorrect!234', undefined, {}),
      /forced security write failure/,
    );
  });
  const unchanged = await storedUser(user);
  assert.equal(unchanged.failedLoginAttempts, 4);
  assert.equal(unchanged.lockedUntil, null);
  assert.equal((await history(user)).length, 0);
  assert.equal(notices.mock.callCount(), 0);
});

test('SMTP failure cannot undo an already committed account lock', async (context) => {
  const user = await account({ failedLoginAttempts: 4, lockedUntil: null }, 0);
  const smtpError = new Error('SMTP unavailable for test');
  context.mock.method(mail.transporter, 'sendMail', async () => {
    throw smtpError;
  });
  const log = context.mock.method(mail.logger, 'error', () => {});
  await assert.rejects(
    auth.login(user.email, 'Incorrect!234', undefined, {}),
    (error) => error instanceof MailDeliveryError && error.cause === smtpError,
  );
  const locked = await storedUser(user);
  assert.ok(locked.lockedUntil.getTime() > Date.now());
  assert.equal(locked.failedLoginAttempts, 0);
  assert.equal((await history(user)).length, 1);
  assert.equal(log.mock.callCount(), 1);
});

test('successful password login stores the real token hash and resets only lockout fields atomically', async () => {
  const user = await account({}, 0);
  const login = await auth.login(user.email, oldPassword, undefined, {
    ipAddress: '127.0.0.1',
  });
  assert.ok(login.accessToken);
  const session = (await userSessions(user))[0];
  assert.equal(session.id, login.sessionId);
  assert.equal(session.refreshTokenHash, digest(login.refreshToken));
  assert.equal(session.revokedAt, null);
  const changed = await storedUser(user);
  assert.equal(changed.lockedUntil, null);
  assert.equal(changed.failedLoginAttempts, 0);
  assert.equal(changed.passwordResetToken, user.passwordResetToken);
  assert.equal(changed.emailVerificationToken, user.emailVerificationToken);
  assert.equal(changed.password, originalHash);
  assert.equal((await history(user))[0].success, true);
  const refreshed = await auth.refreshTokens(
    login.refreshToken,
    auth.computeCsrfToken(login.sessionId),
  );
  assert.ok(refreshed.accessToken);
});

for (const table of ['sessions', 'login_history']) {
  test(`${table} insert failure rolls back login, including counter and expired lock reset`, async () => {
    const user = await account({}, 0);
    await failWrite(table, 'INSERT', async () => {
      await assert.rejects(
        auth.login(user.email, oldPassword, undefined, {}),
        /forced security write failure/,
      );
    });
    const unchanged = await storedUser(user);
    assert.equal(unchanged.failedLoginAttempts, user.failedLoginAttempts);
    assert.equal(unchanged.lockedUntil.getTime(), user.lockedUntil.getTime());
    assert.equal((await userSessions(user)).length, 0);
    assert.equal((await history(user)).length, 0);
  });
}

for (const [name, patch] of [
  ['password', { password: 'replacement-password-hash' }],
  [
    '2FA enablement',
    { isTwoFactorEnabled: true, twoFactorSecret: 'new-encrypted-secret' },
  ],
  ['account lock', { lockedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000) }],
  ['email verification', { isEmailVerified: false }],
]) {
  test(`a ${name} change after validation prevents committing a stale password login`, async (context) => {
    const user = await account({}, 0);
    const commit = users.completePasswordLogin.bind(users);
    context.mock.method(
      users,
      'completePasswordLogin',
      async (snapshot, session) => {
        await database.getRepository(User).update({ id: user.id }, patch);
        await commit(snapshot, session);
      },
    );
    await assert.rejects(
      auth.login(user.email, oldPassword, undefined, {}),
      statusIs(401),
    );
    assert.equal((await userSessions(user)).length, 0);
    assert.equal((await history(user)).length, 0);
    assert.equal(
      (await storedUser(user)).failedLoginAttempts,
      user.failedLoginAttempts,
    );
  });
}

test('token signing failure creates no session and leaves lock counters unchanged', async (context) => {
  const user = await account({}, 0);
  const signingError = new Error('Signing failed for test');
  context.mock.method(jwt, 'signAsync', async () => {
    throw signingError;
  });
  await assert.rejects(
    auth.login(user.email, oldPassword, undefined, {}),
    (error) => error === signingError,
  );
  assert.equal(
    (await storedUser(user)).failedLoginAttempts,
    user.failedLoginAttempts,
  );
  assert.equal((await userSessions(user)).length, 0);
  assert.equal((await history(user)).length, 0);
});

test('forgot-password writes only the token fields and does not restore a stale security snapshot', async (context) => {
  const user = await account();
  const find = users.findByEmail.bind(users);
  const futureLock = new Date(Date.now() + 60_000);
  context.mock.method(users, 'findByEmail', async (email) => {
    const snapshot = await find(email);
    await database.getRepository(User).update(
      { id: user.id },
      {
        password: 'changed-in-another-request',
        failedLoginAttempts: 4,
        lockedUntil: futureLock,
        isTwoFactorEnabled: true,
        twoFactorSecret: 'new-secret',
      },
    );
    return snapshot;
  });
  const sent = context.mock.method(
    mail,
    'sendPasswordReset',
    async (email, token) => {
      assert.equal(email, user.email);
      assert.equal((await storedUser(user)).passwordResetToken, token);
    },
  );
  await auth.forgotPassword(user.email);
  const changed = await storedUser(user);
  assert.equal(changed.password, 'changed-in-another-request');
  assert.equal(changed.failedLoginAttempts, 4);
  assert.equal(changed.lockedUntil.getTime(), futureLock.getTime());
  assert.equal(changed.isTwoFactorEnabled, true);
  assert.equal(changed.twoFactorSecret, 'new-secret');
  assert.notEqual(changed.passwordResetToken, user.passwordResetToken);
  assert.equal(sent.mock.callCount(), 1);
});

test('OAuth linking preserves concurrent password and lock changes and reloads the current account', async (context) => {
  const user = await account({}, 0);
  const find = users.findByEmail.bind(users);
  context.mock.method(users, 'findByEmail', async (email) => {
    const snapshot = await find(email);
    await database.getRepository(User).update(
      { id: user.id },
      {
        password: 'changed-in-another-request',
        lockedUntil: new Date(Date.now() + 60_000),
      },
    );
    return snapshot;
  });
  const providerId = randomUUID();
  await assert.rejects(
    auth.loginWithOAuth(
      {
        provider: 'google',
        providerId,
        email: user.email,
        emailVerified: true,
      },
      {},
    ),
    statusIs(403),
  );
  const changed = await storedUser(user);
  assert.equal(changed.googleId, providerId);
  assert.equal(changed.password, 'changed-in-another-request');
  assert.ok(changed.lockedUntil.getTime() > Date.now());
  assert.equal((await userSessions(user)).length, 0);
});

test('forgot-password keeps identical HTTP responses during SMTP failure and records the failure', async (context) => {
  const user = await account();
  const smtpError = new Error('Private SMTP diagnostics for test');
  context.mock.method(mail.transporter, 'sendMail', async () => {
    throw smtpError;
  });
  const log = context.mock.method(mail.logger, 'error', () => {});
  const responses = [];
  for (const email of [user.email, `${randomUUID()}@example.test`]) {
    const response = await request('/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    assert.equal(response.status, 200);
    responses.push(await response.json());
  }
  assert.deepEqual(responses[0], responses[1]);
  assert.doesNotMatch(responses[0].message, /has been sent|Private SMTP/);
  assert.equal(log.mock.callCount(), 1);
});

test('unexpected persistence failures in forgot-password propagate without sending an email', async (context) => {
  const user = await account();
  const persistenceError = new Error('Database unavailable for test');
  context.mock.method(users, 'storePasswordResetToken', async () => {
    throw persistenceError;
  });
  const sent = context.mock.method(mail, 'sendPasswordReset', async () => {});
  await assert.rejects(
    auth.forgotPassword(user.email),
    (error) => error === persistenceError,
  );
  assert.equal(sent.mock.callCount(), 0);
});

test('MailService propagates failed verification delivery with its original cause', async (context) => {
  const smtpError = new Error('Connection refused for test');
  context.mock.method(mail.transporter, 'sendMail', async () => {
    throw smtpError;
  });
  context.mock.method(mail.logger, 'error', () => {});
  await assert.rejects(
    mail.sendEmailVerification(
      'test@example.test',
      randomBytes(32).toString('hex'),
    ),
    (error) => error instanceof MailDeliveryError && error.cause === smtpError,
  );
});

test('refresh rejects malformed JWT claims before any database lookup', async (context) => {
  const lookup = context.mock.method(
    sessions,
    'requireActiveSession',
    async () => {
      throw new Error('Must not reach database');
    },
  );
  for (const claims of [
    { sub: randomUUID() },
    { sub: 42, sid: randomUUID() },
    { sub: randomUUID(), sid: 'invalid-uuid' },
    { sub: 'invalid-uuid', sid: randomUUID() },
  ]) {
    const token = await jwt.signAsync(claims, {
      secret: testConfig.JWT_REFRESH_SECRET,
    });
    await assert.rejects(auth.refreshTokens(token, undefined), statusIs(401));
  }
  await assert.rejects(
    auth.refreshTokens('not-a-jwt', undefined),
    statusIs(401),
  );
  assert.equal(lookup.mock.callCount(), 0);
});

test('refresh maps a missing session to 401 but propagates unexpected database and verifier failures', async (context) => {
  const user = await account({}, 0);
  const sid = randomUUID();
  const token = await jwt.signAsync(
    { sub: user.id, sid },
    { secret: testConfig.JWT_REFRESH_SECRET },
  );
  const csrf = auth.computeCsrfToken(sid);
  await assert.rejects(auth.refreshTokens(token, csrf), (error) => {
    assert.equal(error.getStatus(), 401);
    assert.equal(error.message, 'Invalid or expired refresh token');
    return true;
  });
  const databaseError = new Error('Database unavailable for test');
  const lookup = context.mock.method(
    sessions,
    'requireActiveSession',
    async () => {
      throw databaseError;
    },
  );
  await assert.rejects(
    auth.refreshTokens(token, csrf),
    (error) => error === databaseError,
  );
  lookup.mock.restore();
  const verifierError = new Error('Verifier unavailable for test');
  context.mock.method(jwt, 'verifyAsync', async () => {
    throw verifierError;
  });
  await assert.rejects(
    auth.refreshTokens(token, csrf),
    (error) => error === verifierError,
  );
});

for (const invalidState of ['revoked', 'expired', 'owned by another user']) {
  test(`refresh rejects a session that is ${invalidState} with the refresh error and no persistence changes`, async () => {
    const user = await account({}, 0);
    const login = await auth.login(user.email, oldPassword, undefined, {});
    const repository = database.getRepository(Session);
    if (invalidState === 'revoked') {
      await repository.update(
        { id: login.sessionId },
        { revokedAt: new Date() },
      );
    } else if (invalidState === 'expired') {
      await repository.update(
        { id: login.sessionId },
        { expiresAt: new Date(Date.now() - 1_000) },
      );
    } else {
      const otherUser = await account({}, 0);
      await repository.update(
        { id: login.sessionId },
        { userId: otherUser.id },
      );
    }
    const beforeRefresh = await repository.findOneByOrFail({
      id: login.sessionId,
    });
    await assert.rejects(
      auth.refreshTokens(
        login.refreshToken,
        auth.computeCsrfToken(login.sessionId),
      ),
      (error) => {
        assert.equal(error.getStatus(), 401);
        assert.equal(error.message, 'Invalid or expired refresh token');
        return true;
      },
    );
    assert.deepEqual(
      await repository.findOneByOrFail({ id: login.sessionId }),
      beforeRefresh,
    );
  });
}

test('HTTP refresh reports database outages as a generic 500 rather than blaming the refresh token', async (context) => {
  const user = await account({}, 0);
  const sid = randomUUID();
  const token = await jwt.signAsync(
    { sub: user.id, sid },
    { secret: testConfig.JWT_REFRESH_SECRET },
  );
  context.mock.method(sessions, 'requireActiveSession', async () => {
    throw new Error('Private database diagnostics');
  });
  const response = await request('/auth/refresh', {
    method: 'POST',
    headers: {
      Cookie: `refresh_token=${token}`,
      'x-csrf-token': auth.computeCsrfToken(sid),
    },
  });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.message, 'Internal server error');
  assert.doesNotMatch(JSON.stringify(body), /Private database/);
});

test('HTTP rejects oversized ASCII, Arabic and emoji passwords before account creation or login', async (context) => {
  const sent = context.mock.method(
    mail,
    'sendEmailVerification',
    async () => {},
  );
  const user = await account({}, 0);
  for (const password of [
    'Aa1!' + 'a'.repeat(69),
    'Aa1!' + 'ع'.repeat(35),
    'Aa1!' + '😀'.repeat(18),
  ]) {
    const email = `${randomUUID()}@example.test`;
    const registration = await request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        firstName: 'Test',
        lastName: 'User',
      }),
    });
    assert.equal(registration.status, 400);
    assert.match(JSON.stringify(await registration.json()), /72 bytes/);
    assert.equal(await users.findByEmail(email), null);
    const login = await request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, password }),
    });
    assert.equal(login.status, 400);
    assert.match(JSON.stringify(await login.json()), /72 bytes/);
  }
  assert.equal(sent.mock.callCount(), 0);
  assert.equal((await userSessions(user)).length, 0);
  assert.equal((await history(user)).length, 0);
});

test('72-byte passwords work through registration, login, change-password and reset-password', async (context) => {
  const passwords = [
    'Aa1!' + 'a'.repeat(68),
    'Aa1!' + 'ع'.repeat(34),
    'Aa1!' + '😀'.repeat(17),
  ];
  const email = `${randomUUID()}@example.test`;
  context.mock.method(mail, 'sendEmailVerification', async () => {});
  const registration = await request('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: passwords[0],
      firstName: 'Test',
      lastName: 'User',
    }),
  });
  assert.equal(registration.status, 201);
  const user = await users.findByEmail(email);
  assert.equal(await bcrypt.compare(passwords[0], user.password), true);
  await auth.verifyEmail(user.emailVerificationToken);
  const login = await request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: passwords[0] }),
  });
  assert.equal(login.status, 200);
  assert.ok((await login.json()).accessToken);
  await auth.changePassword(user.id, passwords[0], passwords[1]);
  assert.equal(
    await bcrypt.compare(passwords[1], (await storedUser(user)).password),
    true,
  );
  assert.ok(
    (await userSessions(user)).every(
      (session) => session.revokedAt instanceof Date,
    ),
  );
  const token = randomBytes(32).toString('hex');
  await database.getRepository(User).update(
    { id: user.id },
    {
      passwordResetToken: token,
      passwordResetExpires: new Date(Date.now() + 60_000),
    },
  );
  await auth.resetPassword(token, passwords[2]);
  assert.equal(
    await bcrypt.compare(passwords[2], (await storedUser(user)).password),
    true,
  );
  assert.ok((await auth.login(email, passwords[2], undefined, {})).accessToken);
});

test('production database settings refuse a plaintext PostgreSQL server without falling back', async () => {
  const target = new DataSource({
    ...databaseOptions({
      NODE_ENV: 'production',
      DB_HOST: postgres.connection.host,
      DB_PORT: String(postgres.connection.port),
      DB_USERNAME: postgres.connection.username,
      DB_PASSWORD: 'test-password',
      DB_NAME: postgres.connection.database,
    }),
    connectTimeoutMS: 3000,
  });
  try {
    await assert.rejects(target.initialize(), /server does not support SSL/i);
    assert.equal(target.isInitialized, false);
  } finally {
    if (target.isInitialized) await target.destroy();
  }
});

test('missing and OAuth-only accounts keep the same password-login response without issuing sessions', async () => {
  const oauthUser = await account(
    { password: null, failedLoginAttempts: 0 },
    0,
  );
  let missingResponse;
  try {
    await auth.login(
      `${randomUUID()}@example.test`,
      oldPassword,
      undefined,
      {},
    );
    assert.fail('Unknown account must be rejected');
  } catch (error) {
    assert.equal(error.getStatus(), 401);
    missingResponse = error.getResponse();
  }
  await assert.rejects(
    auth.login(oauthUser.email, oldPassword, undefined, {}),
    (error) => {
      assert.equal(error.getStatus(), 401);
      assert.deepEqual(error.getResponse(), missingResponse);
      return true;
    },
  );
  assert.equal((await userSessions(oauthUser)).length, 0);
  assert.equal((await storedUser(oauthUser)).failedLoginAttempts, 0);
  assert.equal(
    (await history(oauthUser))[0].failureReason,
    'No password set (OAuth-only account)',
  );
});

test('locked and unverified accounts preserve rejection order and audit behavior', async () => {
  const locked = await account(
    { lockedUntil: new Date(Date.now() + 120000), failedLoginAttempts: 0 },
    0,
  );
  await assert.rejects(
    auth.login(locked.email, 'WrongPassword!234', undefined, {}),
    (error) => {
      assert.equal(error.getStatus(), 403);
      assert.match(error.message, /Account temporarily locked/);
      return true;
    },
  );
  assert.equal((await storedUser(locked)).failedLoginAttempts, 0);
  assert.equal((await history(locked))[0].failureReason, 'Account locked');
  assert.equal((await userSessions(locked)).length, 0);
  const unverified = await account({ isEmailVerified: false }, 0);
  await assert.rejects(
    auth.login(unverified.email, oldPassword, undefined, {}),
    (error) => {
      assert.equal(error.getStatus(), 403);
      assert.equal(
        error.message,
        'Please verify your email address before logging in',
      );
      return true;
    },
  );
  assert.equal((await history(unverified)).length, 0);
  assert.equal((await userSessions(unverified)).length, 0);
});

test('password 2FA issues no session for missing secrets or challenges and records a rejected code before success', async () => {
  const unavailable = await account(
    { isTwoFactorEnabled: true, twoFactorSecret: null },
    0,
  );
  await assert.rejects(
    auth.login(unavailable.email, oldPassword, undefined, {}),
    (error) => {
      assert.equal(error.getStatus(), 401);
      assert.equal(error.message, 'Two-factor authentication is unavailable');
      return true;
    },
  );
  assert.equal((await userSessions(unavailable)).length, 0);
  const user = await account({}, 0);
  const setup = await auth.generateTwoFactorSecret(user.id);
  const code = () =>
    speakeasy.totp({ secret: setup.secret, encoding: 'base32' });
  await auth.enableTwoFactor(
    user.id,
    totpAtStep(setup.secret, (await currentTotpStep()) - 1),
  );
  assert.deepEqual(await auth.login(user.email, oldPassword, undefined, {}), {
    twoFactorRequired: true,
  });
  assert.equal((await userSessions(user)).length, 0);
  await assert.rejects(
    auth.login(user.email, oldPassword, 'not-a-code', {}),
    statusIs(401),
  );
  assert.equal((await storedUser(user)).failedLoginAttempts, 1);
  assert.equal((await history(user))[0].failureReason, 'Invalid 2FA code');
  const login = await auth.login(user.email, oldPassword, code(), {});
  assert.ok(login.accessToken);
  assert.equal((await userSessions(user)).length, 1);
  assert.equal((await storedUser(user)).failedLoginAttempts, 0);
  assert.equal(
    (await history(user)).filter((entry) => entry.success).length,
    1,
  );
});

test('refresh rejects missing and mismatched CSRF before database access and leaves the session usable', async (context) => {
  const user = await account({}, 0);
  const login = await auth.login(user.email, oldPassword, undefined, {});
  const lookup = context.mock.method(
    sessions,
    'requireActiveSession',
    async () => {
      throw new Error('CSRF rejection must precede database access');
    },
  );
  for (const csrf of [
    undefined,
    '',
    'short',
    auth.computeCsrfToken(randomUUID()),
  ]) {
    await assert.rejects(
      auth.refreshTokens(login.refreshToken, csrf),
      (error) => {
        assert.equal(error.getStatus(), 403);
        assert.equal(error.message, 'Invalid or missing CSRF token');
        return true;
      },
    );
  }
  assert.equal(lookup.mock.callCount(), 0);
  lookup.mock.restore();
  assert.equal((await userSessions(user))[0].revokedAt, null);
  assert.ok(
    (
      await auth.refreshTokens(
        login.refreshToken,
        auth.computeCsrfToken(login.sessionId),
      )
    ).accessToken,
  );
});

test('replaying a rotated refresh token preserves whole-session revocation', async () => {
  const user = await account({}, 0);
  const login = await auth.login(user.email, oldPassword, undefined, {});
  const csrf = auth.computeCsrfToken(login.sessionId);
  const rotated = await auth.refreshTokens(login.refreshToken, csrf);
  assert.notEqual(rotated.refreshToken, login.refreshToken);
  await assert.rejects(
    auth.refreshTokens(login.refreshToken, csrf),
    statusIs(401),
  );
  assert.ok((await userSessions(user))[0].revokedAt);
  await assert.rejects(
    auth.refreshTokens(rotated.refreshToken, csrf),
    statusIs(401),
  );
});

test('logout rejects another user token and revokes only the selected session', async () => {
  const owner = await account({}, 0);
  const other = await account({}, 0);
  const first = await auth.login(owner.email, oldPassword, undefined, {});
  const second = await auth.login(owner.email, oldPassword, undefined, {});
  const foreign = await auth.login(other.email, oldPassword, undefined, {});
  await assert.rejects(auth.logout(owner.id, undefined), statusIs(401));
  await assert.rejects(
    auth.logout(owner.id, foreign.refreshToken),
    statusIs(401),
  );
  assert.equal((await userSessions(other))[0].revokedAt, null);
  assert.deepEqual(await auth.logout(owner.id, first.refreshToken), {
    message: 'Logged out successfully',
  });
  const stored = await userSessions(owner);
  assert.ok(stored.find((session) => session.id === first.sessionId).revokedAt);
  assert.equal(
    stored.find((session) => session.id === second.sessionId).revokedAt,
    null,
  );
});

async function oauthAccount() {
  const user = await account({ googleId: randomUUID() }, 0);
  return {
    user,
    profile: {
      provider: 'google',
      providerId: user.googleId,
      email: user.email,
      emailVerified: true,
    },
  };
}

async function oauthChallenge() {
  const identity = await oauthAccount();
  const setup = await auth.generateTwoFactorSecret(identity.user.id);
  const code = () =>
    speakeasy.totp({ secret: setup.secret, encoding: 'base32' });
  await auth.enableTwoFactor(
    identity.user.id,
    totpAtStep(setup.secret, (await currentTotpStep()) - 1),
  );
  const response = await auth.loginWithOAuth(identity.profile, {});
  assert.equal(response.twoFactorRequired, true);
  return { ...identity, token: response.challenge, code };
}

const storedChallenge = (flow) =>
  database
    .getRepository(StaffOAuthChallenge)
    .findOneBy({ tokenHash: digest(flow.token) });

test('OAuth completion: signing failure must leave no placeholder session or success audit', async (context) => {
  const flow = await oauthAccount();
  const signingError = new Error('Injected OAuth signing failure');
  context.mock.method(jwt, 'signAsync', async () => {
    throw signingError;
  });
  await assert.rejects(
    auth.loginWithOAuth(flow.profile, {}),
    (error) => error === signingError,
  );
  assert.equal((await userSessions(flow.user)).length, 0);
  assert.equal((await history(flow.user)).length, 0);
});

test('OAuth completion: audit insert failure must roll back the session', async () => {
  const flow = await oauthAccount();
  await failWrite('login_history', 'INSERT', async () => {
    await assert.rejects(
      auth.loginWithOAuth(flow.profile, {}),
      /forced security write failure/,
    );
  });
  assert.equal((await userSessions(flow.user)).length, 0);
  assert.equal((await history(flow.user)).length, 0);
});

test('OAuth 2FA completion: signing failure must preserve the challenge and create no session', async (context) => {
  const flow = await oauthChallenge();
  const signingError = new Error('Injected OAuth 2FA signing failure');
  const signer = context.mock.method(jwt, 'signAsync', async () => {
    throw signingError;
  });
  await assert.rejects(
    auth.verifyOAuthTwoFactor(flow.token, flow.code(), {}),
    (error) => error === signingError,
  );
  assert.ok(await storedChallenge(flow));
  assert.equal((await userSessions(flow.user)).length, 0);
  assert.equal((await history(flow.user)).length, 0);
  signer.mock.restore();
  const retry = await auth.verifyOAuthTwoFactor(flow.token, flow.code(), {});
  assert.ok(retry.accessToken);
  assert.equal(await storedChallenge(flow), null);
  assert.equal((await userSessions(flow.user)).length, 1);
  assert.equal((await history(flow.user)).length, 1);
});

test('OAuth completion: successful login stores the actual token hash and audit together without resetting unrelated fields', async () => {
  const flow = await oauthAccount();
  const login = await auth.loginWithOAuth(flow.profile, {
    ipAddress: '127.0.0.1',
    userAgent: 'isolated-oauth-test',
  });
  const stored = (await userSessions(flow.user))[0];
  assert.equal(stored.id, login.sessionId);
  assert.equal(stored.refreshTokenHash, digest(login.refreshToken));
  assert.ok(stored.lastUsedAt instanceof Date);
  const entries = await history(flow.user);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].success, true);
  assert.equal(entries[0].ipAddress, '127.0.0.1');
  assert.equal(entries[0].userAgent, 'isolated-oauth-test');
  const unchanged = await storedUser(flow.user);
  assert.equal(unchanged.password, flow.user.password);
  assert.equal(unchanged.failedLoginAttempts, flow.user.failedLoginAttempts);
  assert.equal(unchanged.passwordResetToken, flow.user.passwordResetToken);
});

test('OAuth completion: refresh-token signing failure leaves no session or audit after access-token signing succeeds', async (context) => {
  const flow = await oauthAccount();
  const sign = jwt.signAsync.bind(jwt);
  const signingError = new Error('Injected OAuth refresh signing failure');
  context.mock.method(jwt, 'signAsync', async (payload, options) => {
    if (options.secret === testConfig.JWT_REFRESH_SECRET) throw signingError;
    return sign(payload, options);
  });
  await assert.rejects(
    auth.loginWithOAuth(flow.profile, {}),
    (error) => error === signingError,
  );
  assert.equal((await userSessions(flow.user)).length, 0);
  assert.equal((await history(flow.user)).length, 0);
});

test('OAuth completion: session insert failure leaves no success audit and permits retry', async () => {
  const flow = await oauthAccount();
  await failWrite('sessions', 'INSERT', async () => {
    await assert.rejects(
      auth.loginWithOAuth(flow.profile, {}),
      /forced security write failure/,
    );
  });
  assert.equal((await userSessions(flow.user)).length, 0);
  assert.equal((await history(flow.user)).length, 0);
  assert.ok((await auth.loginWithOAuth(flow.profile, {})).accessToken);
});

for (const [change, mutation, expectedStatus] of [
  ['account lock', { lockedUntil: new Date(Date.now() + 3600000) }, 403],
  [
    '2FA enablement',
    { isTwoFactorEnabled: true, twoFactorSecret: 'newly-enabled-factor' },
    401,
  ],
]) {
  test(`OAuth completion: concurrent ${change} prevents a stale session commit`, async (context) => {
    const flow = await oauthAccount();
    const issuer = application.app.get(AuthSessionService);
    const issue = issuer.issueTokens.bind(issuer);
    context.mock.method(issuer, 'issueTokens', async (user, sessionId) => {
      const tokens = await issue(user, sessionId);
      await database.getRepository(User).update({ id: user.id }, mutation);
      return tokens;
    });
    await assert.rejects(
      auth.loginWithOAuth(flow.profile, {}),
      statusIs(expectedStatus),
    );
    assert.equal((await userSessions(flow.user)).length, 0);
    assert.equal((await history(flow.user)).length, 0);
  });
}

for (const table of ['sessions', 'login_history']) {
  test(`OAuth 2FA completion: ${table} failure rolls back challenge consumption and allows retry`, async () => {
    const flow = await oauthChallenge();
    await failWrite(table, 'INSERT', async () => {
      await assert.rejects(
        auth.verifyOAuthTwoFactor(flow.token, flow.code(), {}),
        /forced security write failure/,
      );
    });
    assert.ok(await storedChallenge(flow));
    assert.equal((await userSessions(flow.user)).length, 0);
    assert.equal((await history(flow.user)).length, 0);
    const retry = await auth.verifyOAuthTwoFactor(flow.token, flow.code(), {});
    assert.ok(retry.accessToken);
    assert.equal(await storedChallenge(flow), null);
    assert.equal((await userSessions(flow.user)).length, 1);
    assert.equal((await history(flow.user)).length, 1);
  });
}

for (const [change, mutation] of [
  ['2FA disablement', { isTwoFactorEnabled: false, twoFactorSecret: null }],
  ['2FA secret rotation', { twoFactorSecret: 'rotated-factor-secret' }],
  ['account lock', { lockedUntil: new Date(Date.now() + 3600000) }],
]) {
  test(`OAuth 2FA completion: concurrent ${change} blocks a previously verified code`, async (context) => {
    const flow = await oauthChallenge();
    const issuer = application.app.get(AuthSessionService);
    const issue = issuer.issueTokens.bind(issuer);
    context.mock.method(issuer, 'issueTokens', async (user, sessionId) => {
      const tokens = await issue(user, sessionId);
      await database.getRepository(User).update({ id: user.id }, mutation);
      return tokens;
    });
    await assert.rejects(
      auth.verifyOAuthTwoFactor(flow.token, flow.code(), {}),
      statusIs(401),
    );
    assert.ok(await storedChallenge(flow));
    assert.equal((await userSessions(flow.user)).length, 0);
    assert.equal((await history(flow.user)).length, 0);
  });
}

test(
  'OAuth 2FA completion: concurrent valid verifiers commit exactly one session and audit',
  { timeout: 15000 },
  async (context) => {
    const flow = await oauthChallenge();
    const issuer = application.app.get(AuthSessionService);
    const issue = issuer.issueTokens.bind(issuer);
    let arrivals = 0;
    let release;
    const rendezvous = new Promise((resolve) => {
      release = resolve;
    });
    context.mock.method(issuer, 'issueTokens', async (user, sessionId) => {
      const tokens = await issue(user, sessionId);
      if (++arrivals === 2) release();
      await rendezvous;
      return tokens;
    });
    const completions = await Promise.allSettled([
      auth.verifyOAuthTwoFactor(flow.token, flow.code(), {}),
      auth.verifyOAuthTwoFactor(flow.token, flow.code(), {}),
    ]);
    assert.equal(
      completions.filter((completion) => completion.status === 'fulfilled')
        .length,
      1,
    );
    assert.equal(
      completions
        .find((completion) => completion.status === 'rejected')
        .reason.getStatus(),
      401,
    );
    assert.equal(await storedChallenge(flow), null);
    assert.equal((await userSessions(flow.user)).length, 1);
    assert.equal((await history(flow.user)).length, 1);
  },
);

test(
  'OAuth 2FA completion: expiry during a user-row lock wait is rechecked using the current database time',
  { timeout: 20000 },
  async () => {
    const flow = await oauthChallenge();
    const locker = database.createQueryRunner();
    await locker.connect();
    await locker.startTransaction();
    let completion;
    try {
      await locker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [
        flow.user.id,
      ]);
      completion = auth.verifyOAuthTwoFactor(flow.token, flow.code(), {});
      completion.catch(() => {});
      const deadline = Date.now() + 10000;
      for (;;) {
        const [activity] =
          await database.query(`SELECT COUNT(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE '%users%' AND query LIKE '%FOR UPDATE%'`);
        if (activity.waiting > 0) break;
        if (Date.now() >= deadline)
          assert.fail('OAuth completion did not wait for the user lock');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await database.query(
        'UPDATE staff_oauth_challenges SET "expiresAt" = clock_timestamp() WHERE "tokenHash" = $1',
        [digest(flow.token)],
      );
    } finally {
      await locker.rollbackTransaction();
      await locker.release();
    }
    await assert.rejects(completion, statusIs(401));
    assert.ok(await storedChallenge(flow));
    assert.equal((await userSessions(flow.user)).length, 0);
    assert.equal((await history(flow.user)).length, 0);
  },
);

test('OAuth 2FA completion: the fifth verification attempt is accepted and an exhausted challenge is rejected', async () => {
  const permitted = await oauthChallenge();
  await database
    .getRepository(StaffOAuthChallenge)
    .update({ tokenHash: digest(permitted.token) }, { attempts: 4 });
  assert.ok(
    (await auth.verifyOAuthTwoFactor(permitted.token, permitted.code(), {}))
      .accessToken,
  );
  assert.equal(await storedChallenge(permitted), null);
  const exhausted = await oauthChallenge();
  await database
    .getRepository(StaffOAuthChallenge)
    .update({ tokenHash: digest(exhausted.token) }, { attempts: 5 });
  await assert.rejects(
    auth.verifyOAuthTwoFactor(exhausted.token, exhausted.code(), {}),
    statusIs(401),
  );
  assert.equal((await storedChallenge(exhausted)).attempts, 5);
  assert.equal((await userSessions(exhausted.user)).length, 0);
  assert.equal((await history(exhausted.user)).length, 0);
});

async function twoFactorSessions(operation) {
  const user = await account({}, 0);
  const setup = await auth.generateTwoFactorSecret(user.id);
  const code = () =>
    totpAtStep(
      setup.secret,
      Math.floor(Date.now() / 30_000) + (operation === 'disable' ? 1 : 0),
    );
  // The disable tests start from an already-enabled account, with two devices using distinct steps.
  if (operation === 'disable')
    await database
      .getRepository(User)
      .update({ id: user.id }, { isTwoFactorEnabled: true });
  const firstCode =
    operation === 'disable'
      ? totpAtStep(setup.secret, (await currentTotpStep()) - 1)
      : undefined;
  const first = await auth.login(user.email, oldPassword, firstCode, {});
  const secondCode =
    operation === 'disable'
      ? totpAtStep(setup.secret, Math.floor(Date.now() / 30_000))
      : undefined;
  const second = await auth.login(user.email, oldPassword, secondCode, {});
  return { user, secret: setup.secret, code, first, second };
}

function changeTwoFactor(flow, operation, code = flow.code()) {
  return request(`/auth/2fa/${operation}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${flow.first.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ code }),
  });
}

for (const operation of ['enable', 'disable']) {
  test(`2FA session protection: ${operation} invalidates existing access and refresh tokens for every device`, async () => {
    const flow = await twoFactorSessions(operation);
    const other = await account({}, 0);
    const foreign = await auth.login(other.email, oldPassword, undefined, {});
    const before = await storedUser(flow.user);
    const previouslyRevokedAt = new Date(Date.now() - 60_000);
    const oldSession = await database.getRepository(Session).save({
      userId: flow.user.id,
      refreshTokenHash: randomBytes(32).toString('hex'),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: previouslyRevokedAt,
    });
    const changed = await changeTwoFactor(flow, operation);
    assert.equal(changed.status, 201);
    assert.deepEqual(await changed.json(), {
      message: `Two-factor authentication ${operation}d`,
    });
    const cookies = changed.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    assert.ok(
      cookies.some((cookie) =>
        /^refresh_token=; Path=\/v1\/auth; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax$/.test(
          cookie,
        ),
      ),
    );
    assert.ok(
      cookies.some((cookie) =>
        /^csrf_token=; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax$/.test(
          cookie,
        ),
      ),
    );
    for (const login of [flow.first, flow.second]) {
      const protectedResponse = await request('/auth/login-history', {
        headers: { authorization: `Bearer ${login.accessToken}` },
      });
      assert.equal(protectedResponse.status, 401);
      const refreshResponse = await request('/auth/refresh', {
        method: 'POST',
        headers: {
          cookie: `refresh_token=${login.refreshToken}`,
          'x-csrf-token': auth.computeCsrfToken(login.sessionId),
        },
      });
      assert.equal(refreshResponse.status, 401);
    }
    assert.ok(
      (await userSessions(flow.user)).every(
        (session) => session.revokedAt instanceof Date,
      ),
    );
    const foreignResponse = await request('/auth/login-history', {
      headers: { authorization: `Bearer ${foreign.accessToken}` },
    });
    assert.equal(foreignResponse.status, 200);
    assert.equal((await userSessions(other))[0].revokedAt, null);
    assert.deepEqual(
      (await sessions.findById(oldSession.id)).revokedAt,
      previouslyRevokedAt,
    );
    const after = await storedUser(flow.user);
    assert.equal(after.isTwoFactorEnabled, operation === 'enable');
    assert.equal(
      after.twoFactorSecret,
      operation === 'enable' ? before.twoFactorSecret : null,
    );
    for (const field of [
      'password',
      'passwordResetToken',
      'passwordResetExpires',
      'emailVerificationToken',
      'emailVerificationExpires',
    ]) {
      assert.deepEqual(after[field], before[field]);
    }
    if (operation === 'enable') {
      assert.deepEqual(
        await auth.login(flow.user.email, oldPassword, undefined, {}),
        { twoFactorRequired: true },
      );
      assert.ok(
        (
          await auth.login(
            flow.user.email,
            oldPassword,
            totpAtStep(flow.secret, Math.floor(Date.now() / 30_000) + 1),
            {},
          )
        ).accessToken,
      );
    } else {
      assert.ok(
        (await auth.login(flow.user.email, oldPassword, undefined, {}))
          .accessToken,
      );
    }
  });

  for (const table of ['users', 'sessions']) {
    test(`2FA session protection: ${operation} rolls back settings and revocation when ${table} rejects the update`, async () => {
      const flow = await twoFactorSessions(operation);
      await database.getRepository(User).update(
        { id: flow.user.id },
        {
          failedLoginAttempts: 4,
          lockedUntil: new Date(Date.now() + 60_000),
        },
      );
      const before = await storedUser(flow.user);
      const sessionSnapshot = await userSessions(flow.user);
      await failWrite(table, 'UPDATE', async () => {
        const rejected = await changeTwoFactor(flow, operation);
        assert.equal(rejected.status, 500);
        assert.equal((await rejected.json()).message, 'Internal server error');
        assert.equal(rejected.headers.getSetCookie().length, 0);
      });
      assert.deepEqual(await storedUser(flow.user), before);
      assert.deepEqual(await userSessions(flow.user), sessionSnapshot);
      const stillAuthenticated = await request('/auth/login-history', {
        headers: { authorization: `Bearer ${flow.second.accessToken}` },
      });
      assert.equal(stillAuthenticated.status, 200);
      assert.ok(
        (
          await auth.refreshTokens(
            flow.second.refreshToken,
            auth.computeCsrfToken(flow.second.sessionId),
          )
        ).accessToken,
      );
      const retry = await changeTwoFactor(flow, operation);
      assert.equal(retry.status, 201);
      assert.equal((await storedUser(flow.user)).failedLoginAttempts, 0);
      assert.equal((await storedUser(flow.user)).lockedUntil, null);
      assert.ok(
        (await userSessions(flow.user)).every((session) => session.revokedAt),
      );
    });
  }

  test(`2FA session protection: a rejected ${operation} code leaves the setting, sessions and cookies unchanged`, async () => {
    const flow = await twoFactorSessions(operation);
    const before = await storedUser(flow.user);
    const sessionSnapshot = await userSessions(flow.user);
    const rejected = await changeTwoFactor(flow, operation, 'ABCDEF');
    assert.equal(rejected.status, 400);
    assert.equal(rejected.headers.getSetCookie().length, 0);
    assert.deepEqual(await storedUser(flow.user), before);
    assert.deepEqual(await userSessions(flow.user), sessionSnapshot);
    assert.equal(
      (
        await request('/auth/login-history', {
          headers: { authorization: `Bearer ${flow.first.accessToken}` },
        })
      ).status,
      200,
    );
  });

  test(`2FA session protection: concurrent ${operation} requests commit exactly one setting change`, async () => {
    const flow = await twoFactorSessions(operation);
    const change = () =>
      operation === 'enable'
        ? auth.enableTwoFactor(flow.user.id, flow.code())
        : auth.disableTwoFactor(flow.user.id, flow.code());
    const attempts = await Promise.allSettled([change(), change()]);
    assert.equal(
      attempts.filter((attempt) => attempt.status === 'fulfilled').length,
      1,
    );
    const rejected = attempts.find((attempt) => attempt.status === 'rejected');
    assert.ok(statusIs(operation === 'enable' ? 409 : 400)(rejected.reason));
    assert.equal(
      (await storedUser(flow.user)).isTwoFactorEnabled,
      operation === 'enable',
    );
    assert.ok(
      (await userSessions(flow.user)).every((session) => session.revokedAt),
    );
  });
}

test('2FA session protection: generating a setup alone preserves existing sessions', async () => {
  const user = await account({}, 0);
  const login = await auth.login(user.email, oldPassword, undefined, {});
  const generated = await request('/auth/2fa/generate', {
    method: 'POST',
    headers: { authorization: `Bearer ${login.accessToken}` },
  });
  assert.equal(generated.status, 201);
  assert.ok((await generated.json()).secret);
  assert.equal(generated.headers.getSetCookie().length, 0);
  assert.equal((await storedUser(user)).isTwoFactorEnabled, false);
  assert.equal((await userSessions(user))[0].revokedAt, null);
  assert.ok(
    (
      await auth.refreshTokens(
        login.refreshToken,
        auth.computeCsrfToken(login.sessionId),
      )
    ).accessToken,
  );
});

test('2FA session protection: enabling also revokes OAuth sessions and blocks outstanding exchange codes', async () => {
  const flow = await oauthAccount();
  const setup = await auth.generateTwoFactorSecret(flow.user.id);
  const login = await auth.loginWithOAuth(flow.profile, {});
  const exchangeCode = await auth.createOAuthExchangeCode(
    login.userId,
    login.sessionId,
  );
  await auth.enableTwoFactor(
    flow.user.id,
    speakeasy.totp({ secret: setup.secret, encoding: 'base32' }),
  );
  await assert.rejects(
    auth.exchangeOAuthCode(exchangeCode, login.refreshToken),
    statusIs(401),
  );
  await assert.rejects(
    auth.refreshTokens(
      login.refreshToken,
      auth.computeCsrfToken(login.sessionId),
    ),
    statusIs(401),
  );
  assert.ok((await userSessions(flow.user))[0].revokedAt);
  const challenge = await auth.loginWithOAuth(flow.profile, {});
  assert.equal(challenge.twoFactorRequired, true);
  assert.match(challenge.challenge, /^[a-f0-9]{64}$/);
  assert.equal(challenge.expiresIn, 300);
  assert.equal((await userSessions(flow.user)).length, 1);
});

test('TOTP replay protection: a successful password login rejects a second use of the same code', async () => {
  const flow = await replayAccount();
  const code = totpAtStep(flow.secret, flow.step);
  const first = await auth.login(flow.user.email, oldPassword, code, {});
  assert.ok(first.accessToken);
  await assert.rejects(
    auth.login(flow.user.email, oldPassword, code, {}),
    statusIs(401),
  );
  assert.equal((await userSessions(flow.user)).length, 1);
  assert.equal(
    (await history(flow.user)).filter((entry) => entry.success).length,
    1,
  );
  assert.equal((await storedUser(flow.user)).failedLoginAttempts, 1);
});

test('TOTP replay protection: independent OAuth challenges cannot reuse one successful code', async () => {
  const flow = await oauthChallenge();
  const second = await auth.loginWithOAuth(flow.profile, {});
  const code = flow.code();
  assert.ok(
    (await auth.verifyOAuthTwoFactor(flow.token, code, {})).accessToken,
  );
  await assert.rejects(
    auth.verifyOAuthTwoFactor(second.challenge, code, {}),
    statusIs(401),
  );
  assert.ok(
    await database
      .getRepository(StaffOAuthChallenge)
      .findOneBy({ tokenHash: digest(second.challenge) }),
  );
  assert.equal((await userSessions(flow.user)).length, 1);
  assert.equal(
    (await history(flow.user)).filter((entry) => entry.success).length,
    1,
  );
});

test('TOTP replay protection: activation consumes its code and the next step works through HTTP without exposing the stored step', async () => {
  const user = await account({ failedLoginAttempts: 0, lockedUntil: null }, 0);
  const setup = await auth.generateTwoFactorSecret(user.id);
  const step = Math.floor(Date.now() / 30_000);
  const activationCode = totpAtStep(setup.secret, step);
  await auth.enableTwoFactor(user.id, activationCode);
  const login = (code) =>
    request('/auth/login', {
      method: 'POST',
      // Keep this client's throttle budget independent of earlier HTTP login tests.
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '192.0.2.10',
      },
      body: JSON.stringify({
        email: user.email,
        password: oldPassword,
        twoFactorCode: code,
      }),
    });
  const rejected = await login(activationCode);
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.getSetCookie().length, 0);
  assert.equal((await userSessions(user)).length, 0);
  assert.equal((await storedUser(user)).twoFactorLastUsedStep, step);
  const accepted = await login(totpAtStep(setup.secret, step + 1));
  assert.equal(accepted.status, 200);
  const profile = await request('/users/me', {
    headers: { authorization: `Bearer ${(await accepted.json()).accessToken}` },
  });
  assert.equal(profile.status, 200);
  assert.ok(!('twoFactorLastUsedStep' in (await profile.json())));
  assert.equal((await storedUser(user)).twoFactorLastUsedStep, step + 1);
});

for (const firstFlow of ['password', 'oauth']) {
  test(`TOTP replay protection: ${firstFlow} consumption also prevents reuse in the other login flow`, async () => {
    const flow = await replayAccount();
    const token = await replayChallenge(flow);
    const code = totpAtStep(flow.secret, flow.step);
    const passwordLogin = () =>
      auth.login(flow.user.email, oldPassword, code, {});
    const oauthLogin = () => auth.verifyOAuthTwoFactor(token, code, {});
    const [first, second] =
      firstFlow === 'password'
        ? [passwordLogin, oauthLogin]
        : [oauthLogin, passwordLogin];
    assert.ok((await first()).accessToken);
    await assert.rejects(second(), statusIs(401));
    assert.equal(
      (await storedUser(flow.user)).twoFactorLastUsedStep,
      flow.step,
    );
    assert.equal((await userSessions(flow.user)).length, 1);
    assert.equal(
      (await history(flow.user)).filter((entry) => entry.success).length,
      1,
    );
  });
}

for (const mode of ['password', 'independent OAuth', 'mixed password/OAuth']) {
  test(
    `TOTP replay protection: simultaneous ${mode} consumers commit exactly one session`,
    { timeout: 20_000 },
    async (context) => {
      const flow = await replayAccount();
      const tokens =
        mode === 'password'
          ? []
          : [await replayChallenge(flow), await replayChallenge(flow)];
      const code = totpAtStep(flow.secret, flow.step);
      const passwordLogin = () =>
        auth.login(flow.user.email, oldPassword, code, {});
      const operations =
        mode === 'password'
          ? [passwordLogin, passwordLogin]
          : mode === 'independent OAuth'
            ? tokens.map(
                (token) => () => auth.verifyOAuthTwoFactor(token, code, {}),
              )
            : [
                passwordLogin,
                () => auth.verifyOAuthTwoFactor(tokens[0], code, {}),
              ];
      const release = synchronizeTokenIssuers(context);
      let attempts;
      try {
        attempts = await Promise.allSettled(
          operations.map((operation) => operation()),
        );
      } finally {
        release();
      }
      assert.equal(
        attempts.filter((attempt) => attempt.status === 'fulfilled').length,
        1,
      );
      assert.ok(
        statusIs(401)(
          attempts.find((attempt) => attempt.status === 'rejected').reason,
        ),
      );
      assert.equal((await userSessions(flow.user)).length, 1);
      assert.equal(
        (await history(flow.user)).filter((entry) => entry.success).length,
        1,
      );
      assert.equal(
        (await storedUser(flow.user)).twoFactorLastUsedStep,
        flow.step,
      );
    },
  );
}

for (const flowType of ['password', 'oauth']) {
  for (const [table, event] of [
    ['users', 'UPDATE'],
    ['sessions', 'INSERT'],
    ['login_history', 'INSERT'],
  ]) {
    test(`TOTP replay protection: ${flowType} ${table} failure rolls back step consumption and permits the same code retry`, async () => {
      const flow = await replayAccount();
      const token =
        flowType === 'oauth' ? await replayChallenge(flow) : undefined;
      const code = totpAtStep(flow.secret, flow.step);
      const login = () =>
        flowType === 'password'
          ? auth.login(flow.user.email, oldPassword, code, {})
          : auth.verifyOAuthTwoFactor(token, code, {});
      const before = await storedUser(flow.user);
      await failWrite(table, event, async () => {
        await assert.rejects(login(), /forced security write failure/);
      });
      assert.deepEqual(await storedUser(flow.user), before);
      assert.equal((await userSessions(flow.user)).length, 0);
      assert.equal((await history(flow.user)).length, 0);
      if (token)
        assert.ok(
          await database
            .getRepository(StaffOAuthChallenge)
            .findOneBy({ tokenHash: digest(token) }),
        );
      assert.ok((await login()).accessToken);
      assert.equal(
        (await storedUser(flow.user)).twoFactorLastUsedStep,
        flow.step,
      );
    });
  }
}

test('TOTP replay protection: password signing failure does not consume the code', async (context) => {
  const flow = await replayAccount();
  const code = totpAtStep(flow.secret, flow.step);
  const before = await storedUser(flow.user);
  const failure = new Error('Injected TOTP signing failure');
  const signer = context.mock.method(jwt, 'signAsync', async () => {
    throw failure;
  });
  await assert.rejects(
    auth.login(flow.user.email, oldPassword, code, {}),
    (error) => error === failure,
  );
  assert.deepEqual(await storedUser(flow.user), before);
  assert.equal((await userSessions(flow.user)).length, 0);
  signer.mock.restore();
  assert.ok(
    (await auth.login(flow.user.email, oldPassword, code, {})).accessToken,
  );
});

test('TOTP replay protection: accepting a future-window code blocks an older unused code', async () => {
  const flow = await replayAccount();
  assert.ok(
    (
      await auth.login(
        flow.user.email,
        oldPassword,
        totpAtStep(flow.secret, flow.step + 1),
        {},
      )
    ).accessToken,
  );
  await assert.rejects(
    auth.login(
      flow.user.email,
      oldPassword,
      totpAtStep(flow.secret, flow.step),
      {},
    ),
    statusIs(401),
  );
  assert.equal(
    (await storedUser(flow.user)).twoFactorLastUsedStep,
    flow.step + 1,
  );
  assert.equal((await userSessions(flow.user)).length, 1);
});

test('TOTP replay protection: an existing account with a null step accepts its first valid code only once', async () => {
  const flow = await replayAccount();
  await database
    .getRepository(User)
    .update({ id: flow.user.id }, { twoFactorLastUsedStep: null });
  const code = totpAtStep(flow.secret, flow.step);
  assert.ok(
    (await auth.login(flow.user.email, oldPassword, code, {})).accessToken,
  );
  await assert.rejects(
    auth.login(flow.user.email, oldPassword, code, {}),
    statusIs(401),
  );
  assert.equal((await storedUser(flow.user)).twoFactorLastUsedStep, flow.step);
});

test('TOTP replay protection: disabling and replacing the secret reset the step and invalidate old challenges', async () => {
  const flow = await replayAccount();
  const oldChallenge = await replayChallenge(flow);
  await auth.disableTwoFactor(flow.user.id, totpAtStep(flow.secret, flow.step));
  assert.equal((await storedUser(flow.user)).twoFactorLastUsedStep, null);
  assert.equal((await storedUser(flow.user)).twoFactorSecret, null);
  const setup = await auth.generateTwoFactorSecret(flow.user.id);
  assert.equal((await storedUser(flow.user)).twoFactorLastUsedStep, null);
  await auth.enableTwoFactor(
    flow.user.id,
    totpAtStep(setup.secret, flow.step - 1),
  );
  assert.equal(
    (await storedUser(flow.user)).twoFactorLastUsedStep,
    flow.step - 1,
  );
  await assert.rejects(
    auth.verifyOAuthTwoFactor(
      oldChallenge,
      totpAtStep(flow.secret, flow.step),
      {},
    ),
    statusIs(401),
  );
  assert.ok(
    (
      await auth.login(
        flow.user.email,
        oldPassword,
        totpAtStep(setup.secret, flow.step),
        {},
      )
    ).accessToken,
  );
});

test(
  'TOTP replay protection: expiry during a user lock wait is rechecked before consuming the step or challenge',
  { timeout: 45_000 },
  async () => {
    const flow = await replayAccount();
    const token = await replayChallenge(flow);
    await database
      .getRepository(User)
      .update({ id: flow.user.id }, { twoFactorLastUsedStep: null });
    const step = await currentTotpStep();
    const previousStep = step - 1;
    const locker = database.createQueryRunner();
    await locker.connect();
    await locker.startTransaction();
    let completion;
    try {
      await locker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [
        flow.user.id,
      ]);
      completion = auth.verifyOAuthTwoFactor(
        token,
        totpAtStep(flow.secret, previousStep),
        {},
      );
      completion.catch(() => {});
      const deadline = Date.now() + 10_000;
      for (;;) {
        const [activity] =
          await database.query(`SELECT COUNT(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE '%users%' AND query LIKE '%FOR UPDATE%'`);
        if (activity.waiting > 0) break;
        if (Date.now() >= deadline)
          assert.fail('TOTP completion did not wait for the user lock');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      for (;;) {
        const [clock] = await database.query(
          'SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) / 30)::int AS step',
        );
        if (clock.step > previousStep + 1) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      await locker.rollbackTransaction();
      await locker.release();
    }
    await assert.rejects(completion, statusIs(401));
    assert.equal((await storedUser(flow.user)).twoFactorLastUsedStep, null);
    assert.equal((await userSessions(flow.user)).length, 0);
    assert.ok(
      await database
        .getRepository(StaffOAuthChallenge)
        .findOneBy({ tokenHash: digest(token) }),
    );
    assert.ok(
      (
        await auth.verifyOAuthTwoFactor(
          token,
          totpAtStep(flow.secret, Math.floor(Date.now() / 30_000)),
          {},
        )
      ).accessToken,
    );
  },
);
