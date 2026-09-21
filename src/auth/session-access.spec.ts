import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { SessionService } from '../sessions/session.service';

const userId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';

describe('Staff session-bound access', () => {
  const config = new ConfigService({
    JWT_ACCESS_SECRET: 'test-access-secret',
    JWT_REFRESH_SECRET: 'test-refresh-secret',
    OAUTH_CODE_SECRET: 'test-exchange-secret',
    JWT_ACCESS_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '7d',
    CSRF_SECRET: 'test-csrf-secret',
  });
  let session: any;
  let repository: any;
  let sessions: SessionService;
  let users: any;
  let strategy: JwtStrategy;
  let auth: AuthService;
  const jwt = new JwtService();

  beforeEach(() => {
    session = { id: sessionId, userId, expiresAt: new Date(Date.now() + 60000), revokedAt: null };
    repository = { findOne: jest.fn(async ({ where }) =>
      session && where.id === session.id && where.userId === session.userId ? session : null) };
    sessions = new SessionService(repository);
    const user = { id: userId, email: 'staff@example.test', userRoles: [] };
    users = { findById: jest.fn().mockResolvedValue(user), findByIdWithAuthorization: jest.fn().mockResolvedValue(user) };
    strategy = new JwtStrategy(config, users, sessions);
    auth = new AuthService(users, jwt, config, {} as any, sessions, {} as any, {} as any);
  });

  it('accepts an active session, then rejects the same access payload after revocation', async () => {
    const payload = { sub: userId, email: 'staff@example.test', sid: sessionId };
    await expect(strategy.validate(payload)).resolves.toMatchObject({ id: userId });
    session.revokedAt = new Date();
    await expect(strategy.validate(payload)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each(['missing', 'malformed', 'deleted', 'expired', 'wrong-owner'])(
    'rejects a %s session', async (scenario) => {
      const payload: any = { sub: userId, email: 'staff@example.test', sid: sessionId };
      if (scenario === 'missing') delete payload.sid;
      if (scenario === 'malformed') payload.sid = 'invalid';
      if (scenario === 'deleted') session = null;
      if (scenario === 'expired') session.expiresAt = new Date(Date.now() - 1);
      if (scenario === 'wrong-owner') session.userId = '33333333-3333-4333-8333-333333333333';
      await expect(strategy.validate(payload)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(users.findByIdWithAuthorization).not.toHaveBeenCalled();
    },
  );

  it('binds OAuth exchange and access tokens to the login session', async () => {
    const code = await auth.createOAuthExchangeCode(userId, sessionId);
    const { accessToken } = await auth.exchangeOAuthCode(code);
    const payload = await jwt.verifyAsync(accessToken, { secret: config.get('JWT_ACCESS_SECRET') });
    expect(payload.sid).toBe(sessionId);
    await expect(strategy.validate(payload)).resolves.toMatchObject({ id: userId });
    session.revokedAt = new Date();
    await expect(auth.exchangeOAuthCode(code)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects legacy OAuth codes without a session', async () => {
    const code = await jwt.signAsync({ sub: userId, type: 'oauth_exchange' }, { secret: config.get('OAUTH_CODE_SECRET') });
    await expect(auth.exchangeOAuthCode(code)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('includes the session in both tokens issued for login and refresh', async () => {
    const tokens = await (auth as any).issueTokens({ id: userId, email: 'staff@example.test' }, sessionId);
    expect(jwt.verify(tokens.accessToken, { secret: config.get('JWT_ACCESS_SECRET') }).sid).toBe(sessionId);
    expect(jwt.verify(tokens.refreshToken, { secret: config.get('JWT_REFRESH_SECRET') }).sid).toBe(sessionId);
  });

  it('keeps CSRF stable within a session and different between sessions', () => {
    expect(auth.computeCsrfToken(sessionId)).toBe(auth.computeCsrfToken(sessionId));
    expect(auth.computeCsrfToken(sessionId)).not.toBe(auth.computeCsrfToken(userId));
  });
});
