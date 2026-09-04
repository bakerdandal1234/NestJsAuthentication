import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import typeormConfig from '../src/config/typeorm.config';
import { validate } from '../src/config/env.validation';
import { AuthModule } from '../src/auth/auth.module';
import { UsersModule } from '../src/users/users.module';
import { MailModule } from '../src/mail/mail.module';
import { SessionsModule } from '../src/sessions/sessions.module';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { UsersService } from '../src/users/users.service';
import { SessionService } from '../src/sessions/session.service';
import { User } from '../src/users/entities/user.entity';
import { Session } from '../src/sessions/entities/session.entity';

/**
 * Mirrors AppModule exactly, EXCEPT it deliberately does not register
 * ThrottlerModule/ThrottlerGuard. overrideGuard() is documented as
 * unreliable for guards bound via APP_GUARD (nestjs/nest#2515, #5821,
 * #10366), so instead of fighting that, this test-only module simply never
 * wires the throttler in — JwtAuthGuard and RolesGuard are still fully
 * active, so auth/RBAC behavior under test is unaffected.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate, load: [typeormConfig] }),
    TypeOrmModule.forRootAsync({ useFactory: typeormConfig }),
    AuthModule,
    UsersModule,
    MailModule,
    SessionsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
class TestAppModule {}

/**
 * Stage 8 of Session Management: end-to-end tests, one scenario added per
 * request. This spec runs against the real DB configured in .env — each
 * test creates its own uniquely-emailed user and cleans up after itself.
 */
describe('Session Management (e2e)', () => {
  let app: INestApplication<App>;
  let usersService: UsersService;
  let sessionService: SessionService;
  let userRepository: Repository<User>;
  let sessionRepository: Repository<Session>;

  const testEmail = `session-test-${Date.now()}@example.com`;
  const multiSessionTestEmail = `session-test-multi-${Date.now()}@example.com`;
  const rotationTestEmail = `session-test-rotation-${Date.now()}@example.com`;
  const reuseTestEmail = `session-test-reuse-${Date.now()}@example.com`;
  const revokeTestEmail = `session-test-revoke-${Date.now()}@example.com`;
  const logoutTestEmail = `session-test-logout-${Date.now()}@example.com`;
  const logoutAllTestEmail = `session-test-logout-all-${Date.now()}@example.com`;
  const expirationTestEmail = `session-test-expiration-${Date.now()}@example.com`;
  const testPassword = 'Test1234!';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [TestAppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Mirror main.ts bootstrap so routes/validation behave exactly like
    // the real running app (URI versioning -> /v1/..., global ValidationPipe).
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );

    await app.init();

    usersService = app.get(UsersService);
    sessionService = app.get(SessionService);
    userRepository = app.get(getRepositoryToken(User));
    sessionRepository = app.get(getRepositoryToken(Session));
  });

  afterAll(async () => {
    // Cascades to sessions + login_history (onDelete: CASCADE on both).
    if (userRepository) {
      await userRepository.delete({ email: testEmail });
      await userRepository.delete({ email: multiSessionTestEmail });
      await userRepository.delete({ email: rotationTestEmail });
      await userRepository.delete({ email: reuseTestEmail });
      await userRepository.delete({ email: revokeTestEmail });
      await userRepository.delete({ email: logoutTestEmail });
      await userRepository.delete({ email: logoutAllTestEmail });
      await userRepository.delete({ email: expirationTestEmail });
    }
    if (app) {
      await app.close();
    }
  });

  it('Login creates a Session', async () => {
    // 1. Register the test user.
    await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email: testEmail, password: testPassword })
      .expect(201);

    // 2. Mark the user as email-verified directly — no real inbox in tests.
    const registeredUser = await usersService.findByEmail(testEmail);
    expect(registeredUser).not.toBeNull();
    registeredUser!.isEmailVerified = true;
    await usersService.save(registeredUser!);

    // 3. Log in.
    const loginRes = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: testEmail, password: testPassword })
      .expect(200);

    expect(loginRes.body.accessToken).toEqual(expect.any(String));
    expect(loginRes.body.refreshToken).toEqual(expect.any(String));

    // 4. A Session row must have actually been created for this login.
    const sessions = await sessionService.getUserSessions(registeredUser!.id);
    expect(sessions).toHaveLength(1);

    const session = sessions[0];
    expect(session.userId).toBe(registeredUser!.id);
    expect(session.revokedAt).toBeNull();
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // The temporary "pending-<uuid>" placeholder (see AuthService.login())
    // must have been overwritten with the real bcrypt hash by the time
    // login() returns.
    expect(session.refreshTokenHash.startsWith('pending-')).toBe(false);
    expect(session.refreshTokenHash.length).toBeGreaterThan(20);
  });

  it('Multiple sessions can exist for the same user', async () => {
    // 1. Register + verify a dedicated user for this test.
    await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email: multiSessionTestEmail, password: testPassword })
      .expect(201);

    const user = await usersService.findByEmail(multiSessionTestEmail);
    expect(user).not.toBeNull();
    user!.isEmailVerified = true;
    await usersService.save(user!);

    // 2. Log in twice — simulates the same user on two different devices.
    const loginRes1 = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: multiSessionTestEmail, password: testPassword })
      .expect(200);

    const loginRes2 = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: multiSessionTestEmail, password: testPassword })
      .expect(200);

    // 3. Two genuinely distinct Session rows must now exist.
    const sessions = await sessionService.getUserSessions(user!.id);
    expect(sessions).toHaveLength(2);

    const uniqueSessionIds = new Set(sessions.map((s) => s.id));
    expect(uniqueSessionIds.size).toBe(2);

    // Each login must have produced its own distinct refresh token.
    expect(loginRes1.body.refreshToken).not.toBe(loginRes2.body.refreshToken);

    // Both sessions belong to this user and neither is revoked yet.
    for (const session of sessions) {
      expect(session.userId).toBe(user!.id);
      expect(session.revokedAt).toBeNull();
    }
  });

  it('Refresh token rotation issues new tokens and updates the same session', async () => {
    // 1. Register + verify a dedicated user for this test.
    await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email: rotationTestEmail, password: testPassword })
      .expect(201);

    const user = await usersService.findByEmail(rotationTestEmail);
    expect(user).not.toBeNull();
    user!.isEmailVerified = true;
    await usersService.save(user!);

    // 2. Log in to get the initial token pair + session.
    const loginRes = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: rotationTestEmail, password: testPassword })
      .expect(200);

    const originalAccessToken = loginRes.body.accessToken;
    const originalRefreshToken = loginRes.body.refreshToken;

    const sessionsBefore = await sessionService.getUserSessions(user!.id);
    expect(sessionsBefore).toHaveLength(1);
    const sessionId = sessionsBefore[0].id;
    const hashBefore = sessionsBefore[0].refreshTokenHash;

    // 3. Refresh using the original refresh token.
    const refreshRes = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: originalRefreshToken })
      .expect(200);

    // 4. Both tokens must be brand new, not copies of the originals.
    expect(refreshRes.body.accessToken).toEqual(expect.any(String));
    expect(refreshRes.body.refreshToken).toEqual(expect.any(String));
    expect(refreshRes.body.accessToken).not.toBe(originalAccessToken);
    expect(refreshRes.body.refreshToken).not.toBe(originalRefreshToken);

    // 5. Same session row (rotation, not a new session) but with an updated hash.
    const sessionsAfter = await sessionService.getUserSessions(user!.id);
    expect(sessionsAfter).toHaveLength(1);
    expect(sessionsAfter[0].id).toBe(sessionId);
    expect(sessionsAfter[0].refreshTokenHash).not.toBe(hashBefore);
    expect(sessionsAfter[0].lastUsedAt).not.toBeNull();
  });

  it('Reusing an old (already rotated) refresh token is rejected and revokes the session', async () => {
    // 1. Register + verify a dedicated user for this test.
    await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email: reuseTestEmail, password: testPassword })
      .expect(201);

    const user = await usersService.findByEmail(reuseTestEmail);
    expect(user).not.toBeNull();
    user!.isEmailVerified = true;
    await usersService.save(user!);

    // 2. Log in.
    const loginRes = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: reuseTestEmail, password: testPassword })
      .expect(200);

    const originalRefreshToken = loginRes.body.refreshToken;

    const sessionsAfterLogin = await sessionService.getUserSessions(user!.id);
    expect(sessionsAfterLogin).toHaveLength(1);
    const sessionId = sessionsAfterLogin[0].id;

    // 3. A legitimate refresh: rotates the token, session stays alive.
    const firstRefreshRes = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: originalRefreshToken })
      .expect(200);

    const rotatedRefreshToken = firstRefreshRes.body.refreshToken;

    // 4. Reusing the OLD token (already rotated away) must be rejected.
    await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: originalRefreshToken })
      .expect(401);

    // 5. The session must now be revoked as a defensive measure — reuse
    // of a stale refresh token is treated as a possible theft signal.
    const session = await sessionService.findById(sessionId);
    expect(session.revokedAt).not.toBeNull();

    // 6. Even the legitimately-rotated token must now be rejected too:
    // once reuse is detected, the whole session dies and a fresh login
    // is required — not just a fresh rotation.
    await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: rotatedRefreshToken })
      .expect(401);
  });

  it('Revoking a session via DELETE /sessions/:id blocks further refreshes with it', async () => {
    // 1. Register + verify a dedicated user for this test.
    await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email: revokeTestEmail, password: testPassword })
      .expect(201);

    const user = await usersService.findByEmail(revokeTestEmail);
    expect(user).not.toBeNull();
    user!.isEmailVerified = true;
    await usersService.save(user!);

    // 2. Log in.
    const loginRes = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: revokeTestEmail, password: testPassword })
      .expect(200);

    const accessToken = loginRes.body.accessToken;
    const refreshToken = loginRes.body.refreshToken;

    // 3. Fetch the session id through the real GET /sessions endpoint —
    // not by reaching into the service directly, to exercise the actual
    // client-facing API built in Stage 6.
    const listRes = await request(app.getHttpServer())
      .get('/v1/sessions')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(listRes.body).toHaveLength(1);
    const sessionId = listRes.body[0].id;

    // 4. Revoke it through DELETE /sessions/:id.
    const revokeRes = await request(app.getHttpServer())
      .delete(`/v1/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(revokeRes.body.message).toEqual(expect.any(String));

    // 5. The session must actually be revoked in the database.
    const session = await sessionService.findById(sessionId);
    expect(session.revokedAt).not.toBeNull();

    // 6. Its refresh token must no longer work.
    await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken })
      .expect(401);
  });

  it('Logout revokes only the current session, not all sessions', async () => {
    // 1. Register + verify a dedicated user for this test.
    await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email: logoutTestEmail, password: testPassword })
      .expect(201);

    const user = await usersService.findByEmail(logoutTestEmail);
    expect(user).not.toBeNull();
    user!.isEmailVerified = true;
    await usersService.save(user!);

    // 2. Log in twice — two separate sessions (e.g. two devices).
    const loginA = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: logoutTestEmail, password: testPassword })
      .expect(200);

    const loginB = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: logoutTestEmail, password: testPassword })
      .expect(200);

    const accessTokenA = loginA.body.accessToken;
    const refreshTokenA = loginA.body.refreshToken;
    const refreshTokenB = loginB.body.refreshToken;

    const sessionsBefore = await sessionService.getUserSessions(user!.id);
    expect(sessionsBefore).toHaveLength(2);

    // 3. Log out of session A only — access token identifies the user,
    // refresh token in the body identifies *which* session (sid).
    const logoutRes = await request(app.getHttpServer())
      .post('/v1/auth/logout')
      .set('Authorization', `Bearer ${accessTokenA}`)
      .send({ refreshToken: refreshTokenA })
      .expect(200);

    expect(logoutRes.body.message).toEqual(expect.any(String));

    // 4. Exactly ONE of the two sessions must be revoked — not both.
    const sessionsAfter = await sessionService.getUserSessions(user!.id);
    const revokedSessions = sessionsAfter.filter((s) => s.revokedAt !== null);
    const activeSessions = sessionsAfter.filter((s) => s.revokedAt === null);
    expect(revokedSessions).toHaveLength(1);
    expect(activeSessions).toHaveLength(1);

    // 5. Session A's refresh token no longer works.
    await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: refreshTokenA })
      .expect(401);

    // 6. Session B's refresh token still works fine — proving logout did
    // NOT touch every session belonging to this user.
    await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: refreshTokenB })
      .expect(200);
  });

  it('Logout All revokes every session for the user', async () => {
    // 1. Register + verify a dedicated user for this test.
    await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email: logoutAllTestEmail, password: testPassword })
      .expect(201);

    const user = await usersService.findByEmail(logoutAllTestEmail);
    expect(user).not.toBeNull();
    user!.isEmailVerified = true;
    await usersService.save(user!);

    // 2. Log in three times — three separate sessions.
    const logins: { accessToken: string; refreshToken: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: logoutAllTestEmail, password: testPassword })
        .expect(200);
      logins.push(res.body);
    }

    const sessionsBefore = await sessionService.getUserSessions(user!.id);
    expect(sessionsBefore).toHaveLength(3);
    expect(sessionsBefore.every((s) => s.revokedAt === null)).toBe(true);

    // 3. Revoke every session via DELETE /sessions — any one valid access
    // token is enough, since it just identifies *who's* asking.
    const revokeAllRes = await request(app.getHttpServer())
      .delete('/v1/sessions')
      .set('Authorization', `Bearer ${logins[0].accessToken}`)
      .expect(200);

    expect(revokeAllRes.body.message).toEqual(expect.any(String));

    // 4. All three sessions must now be revoked — not just the one used
    // to authenticate the request.
    const sessionsAfter = await sessionService.getUserSessions(user!.id);
    expect(sessionsAfter).toHaveLength(3);
    expect(sessionsAfter.every((s) => s.revokedAt !== null)).toBe(true);

    // 5. None of the three refresh tokens work anymore.
    for (const { refreshToken } of logins) {
      await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refreshToken })
        .expect(401);
    }
  });
});
