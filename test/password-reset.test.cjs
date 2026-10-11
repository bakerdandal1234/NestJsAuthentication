require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { after, before, test } = require('node:test');
const bcrypt = require('bcryptjs');
const { BadRequestException } = require('@nestjs/common');
const { DataSource } = require('typeorm');
const { AuthService } = require('../src/auth/auth.service');
const { UsersService } = require('../src/users/users.service');
const { User } = require('../src/users/entities/user.entity');
const { LoginHistory } = require('../src/users/entities/login-history.entity');
const { Permission } = require('../src/users/entities/permission.entity');
const { Role } = require('../src/users/entities/role.entity');
const {
  RolePermission,
} = require('../src/users/entities/role-permission.entity');
const { UserRole } = require('../src/users/entities/user-role.entity');
const { Session } = require('../src/sessions/entities/session.entity');
const { startPostgres, stopPostgres } = require('./helpers/postgres.cjs');

const newPassword = 'NewPassword!234';
let postgres;
let dataSource;
let usersService;
let authService;
let originalPasswordHash;

before(
  async () => {
    postgres = await startPostgres();
    dataSource = new DataSource({
      type: 'postgres',
      ...postgres.connection,
      connectTimeoutMS: 10_000,
      entities: [
        User,
        LoginHistory,
        Session,
        Role,
        Permission,
        UserRole,
        RolePermission,
      ],
      synchronize: true,
    });
    await dataSource.initialize();
    originalPasswordHash = await bcrypt.hash('OldPassword!234', 4);
    usersService = new UsersService(
      dataSource.getRepository(User),
      dataSource.getRepository(LoginHistory),
    );
    authService = new AuthService(usersService);
  },
  { timeout: 180_000 },
);

after(
  async () => {
    try {
      if (dataSource?.isInitialized) await dataSource.destroy();
    } finally {
      if (postgres) await stopPostgres(postgres.directory);
    }
  },
  { timeout: 60_000 },
);

async function createAccount(overrides = {}) {
  const token = randomBytes(32).toString('hex');
  const userRepository = dataSource.getRepository(User);
  const user = await userRepository.save(
    userRepository.create({
      email: `${randomUUID()}@example.test`,
      password: originalPasswordHash,
      isEmailVerified: true,
      passwordResetToken: token,
      passwordResetExpires: new Date(Date.now() + 60_000),
      failedLoginAttempts: 4,
      lockedUntil: new Date(Date.now() + 60_000),
      ...overrides,
    }),
  );
  const sessionRepository = dataSource.getRepository(Session);
  const sessions = await sessionRepository.save(
    [0, 1].map(() =>
      sessionRepository.create({
        userId: user.id,
        refreshTokenHash: randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ),
  );
  return { user, token, sessions };
}

function invalidResetToken(error) {
  return (
    error instanceof BadRequestException &&
    error.getStatus() === 400 &&
    error.message === 'Invalid or expired password reset token'
  );
}

test('reset clears the token, expiry and lock, hashes the password and revokes only its user sessions', async () => {
  const account = await createAccount();
  const otherAccount = await createAccount();

  assert.deepEqual(
    await authService.resetPassword(account.token, newPassword),
    {
      message:
        'Password reset successfully. Please log in with your new password.',
    },
  );

  const resetUser = await dataSource
    .getRepository(User)
    .findOneByOrFail({ id: account.user.id });
  assert.equal(resetUser.passwordResetToken, null);
  assert.equal(resetUser.passwordResetExpires, null);
  assert.equal(resetUser.lockedUntil, null);
  assert.equal(resetUser.failedLoginAttempts, 0);
  assert.equal(await bcrypt.compare(newPassword, resetUser.password), true);
  assert.equal(
    await bcrypt.compare('OldPassword!234', resetUser.password),
    false,
  );
  const ownSessions = await dataSource
    .getRepository(Session)
    .findBy({ userId: resetUser.id });
  assert.equal(ownSessions.length, 2);
  assert.ok(ownSessions.every((session) => session.revokedAt instanceof Date));
  const otherSessions = await dataSource
    .getRepository(Session)
    .findBy({ userId: otherAccount.user.id });
  assert.ok(otherSessions.every((session) => session.revokedAt === null));
});

test('a consumed token cannot reset the password again', async () => {
  const account = await createAccount();
  await authService.resetPassword(account.token, newPassword);

  await assert.rejects(
    authService.resetPassword(account.token, 'AnotherPassword!234'),
    invalidResetToken,
  );
  const resetUser = await dataSource
    .getRepository(User)
    .findOneByOrFail({ id: account.user.id });
  assert.equal(await bcrypt.compare(newPassword, resetUser.password), true);
});

test('unknown and empty tokens are rejected', async () => {
  for (const token of ['', randomBytes(32).toString('hex')]) {
    await assert.rejects(
      authService.resetPassword(token, newPassword),
      invalidResetToken,
    );
  }
});

test('expired tokens and tokens without an expiry leave the account and sessions unchanged', async () => {
  for (const passwordResetExpires of [new Date(Date.now() - 1_000), null]) {
    const account = await createAccount({ passwordResetExpires });
    await assert.rejects(
      authService.resetPassword(account.token, newPassword),
      invalidResetToken,
    );
    const unchangedUser = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: account.user.id });
    assert.equal(unchangedUser.password, originalPasswordHash);
    assert.equal(unchangedUser.passwordResetToken, account.token);
    const sessions = await dataSource
      .getRepository(Session)
      .findBy({ userId: account.user.id });
    assert.ok(sessions.every((session) => session.revokedAt === null));
  }
});

test(
  'two requests that read the same valid token allow exactly one reset to commit',
  { timeout: 15_000 },
  async (context) => {
    const account = await createAccount();
    const findByToken =
      usersService.findByPasswordResetToken.bind(usersService);
    let lookupCount = 0;
    let releaseLookups;
    const bothLookupsComplete = new Promise((resolve) => {
      releaseLookups = resolve;
    });
    context.mock.method(
      usersService,
      'findByPasswordResetToken',
      async (token) => {
        const user = await findByToken(token);
        lookupCount += 1;
        if (lookupCount === 2) releaseLookups();
        await bothLookupsComplete;
        return user;
      },
    );

    const concurrentResets = await Promise.allSettled([
      authService.resetPassword(account.token, newPassword),
      authService.resetPassword(account.token, 'ConcurrentPassword!234'),
    ]);
    const committedResets = concurrentResets.filter(
      (reset) => reset.status === 'fulfilled',
    );
    const rejectedResets = concurrentResets.filter(
      (reset) => reset.status === 'rejected',
    );
    assert.equal(committedResets.length, 1);
    assert.equal(rejectedResets.length, 1);
    assert.ok(invalidResetToken(rejectedResets[0].reason));
    const resetUser = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: account.user.id });
    const winningPassword =
      concurrentResets[0].status === 'fulfilled'
        ? newPassword
        : 'ConcurrentPassword!234';
    assert.equal(
      await bcrypt.compare(winningPassword, resetUser.password),
      true,
    );
    assert.equal(resetUser.passwordResetToken, null);
  },
);

test('a token replaced after lookup cannot overwrite the password or consume the replacement', async (context) => {
  const account = await createAccount();
  const replacementToken = randomBytes(32).toString('hex');
  const findByToken = usersService.findByPasswordResetToken.bind(usersService);
  context.mock.method(
    usersService,
    'findByPasswordResetToken',
    async (token) => {
      const user = await findByToken(token);
      await dataSource
        .getRepository(User)
        .update({ id: user.id }, { passwordResetToken: replacementToken });
      return user;
    },
  );

  await assert.rejects(
    authService.resetPassword(account.token, newPassword),
    invalidResetToken,
  );
  const unchangedUser = await dataSource
    .getRepository(User)
    .findOneByOrFail({ id: account.user.id });
  assert.equal(unchangedUser.password, originalPasswordHash);
  assert.equal(unchangedUser.passwordResetToken, replacementToken);
});

test('a token that expires after lookup is rejected again at consumption', async (context) => {
  const account = await createAccount();
  const findByToken = usersService.findByPasswordResetToken.bind(usersService);
  context.mock.method(
    usersService,
    'findByPasswordResetToken',
    async (token) => {
      const user = await findByToken(token);
      await dataSource
        .getRepository(User)
        .update(
          { id: user.id },
          { passwordResetExpires: new Date(Date.now() - 1_000) },
        );
      return user;
    },
  );

  await assert.rejects(
    authService.resetPassword(account.token, newPassword),
    invalidResetToken,
  );
  const unchangedUser = await dataSource
    .getRepository(User)
    .findOneByOrFail({ id: account.user.id });
  assert.equal(unchangedUser.password, originalPasswordHash);
  assert.equal(unchangedUser.passwordResetToken, account.token);
});

test('failed session revocation rolls back the password, token consumption and lock reset', async () => {
  const account = await createAccount();
  await dataSource.query(`
    CREATE FUNCTION fail_session_revocation() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'session revocation failed for test'; END;
    $$ LANGUAGE plpgsql
  `);
  await dataSource.query(`
    CREATE TRIGGER fail_session_revocation BEFORE UPDATE ON sessions
    FOR EACH ROW EXECUTE FUNCTION fail_session_revocation()
  `);
  try {
    await assert.rejects(
      authService.resetPassword(account.token, newPassword),
      /session revocation failed for test/,
    );
  } finally {
    await dataSource.query('DROP TRIGGER fail_session_revocation ON sessions');
    await dataSource.query('DROP FUNCTION fail_session_revocation()');
  }

  const unchangedUser = await dataSource
    .getRepository(User)
    .findOneByOrFail({ id: account.user.id });
  assert.equal(unchangedUser.password, originalPasswordHash);
  assert.equal(unchangedUser.passwordResetToken, account.token);
  assert.equal(
    unchangedUser.passwordResetExpires.getTime(),
    account.user.passwordResetExpires.getTime(),
  );
  assert.equal(
    unchangedUser.failedLoginAttempts,
    account.user.failedLoginAttempts,
  );
  assert.equal(
    unchangedUser.lockedUntil.getTime(),
    account.user.lockedUntil.getTime(),
  );
  const sessions = await dataSource
    .getRepository(Session)
    .findBy({ userId: account.user.id });
  assert.ok(sessions.every((session) => session.revokedAt === null));
  await authService.resetPassword(account.token, newPassword);
});
