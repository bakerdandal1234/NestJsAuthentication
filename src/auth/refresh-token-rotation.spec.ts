import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

const userId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';

describe('Refresh token rotation (concurrency-safe)', () => {
  const config = new ConfigService({
    JWT_ACCESS_SECRET: 'test-access-secret',
    JWT_REFRESH_SECRET: 'test-refresh-secret',
    JWT_ACCESS_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '7d',
    CSRF_SECRET: 'test-csrf-secret',
  });
  const jwt = new JwtService();
  let session: any;
  let sessions: any;
  let users: any;
  let auth: AuthService;

  beforeEach(() => {
    session = {
      id: sessionId,
      userId,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    };
    sessions = {
      findById: jest.fn().mockResolvedValue(session),
      rotateRefreshTokenIfMatches: jest.fn().mockResolvedValue(true),
      revokeSession: jest.fn().mockResolvedValue(undefined),
    };
    users = {
      findById: jest.fn().mockResolvedValue({ id: userId, email: 'staff@example.test' }),
    };
    auth = new AuthService(users, jwt, config, {} as any, sessions, {} as any, {} as any);
  });

  async function issueRefreshToken(): Promise<string> {
    return jwt.signAsync(
      { sub: userId, email: 'staff@example.test', sid: sessionId },
      { secret: config.get('JWT_REFRESH_SECRET'), expiresIn: '7d' },
    );
  }

  it("rotates via a single conditional update, keyed on the presented token's hash", async () => {
    const refreshToken = await issueRefreshToken();
    const csrfToken = auth.computeCsrfToken(sessionId);

    const result = await auth.refreshTokens(refreshToken, csrfToken);

    expect(sessions.rotateRefreshTokenIfMatches).toHaveBeenCalledTimes(1);
    const [calledSessionId, expectedHash, newHash] = sessions.rotateRefreshTokenIfMatches.mock.calls[0];
    expect(calledSessionId).toBe(sessionId);
    expect(typeof expectedHash).toBe('string');
    expect(newHash).not.toBe(expectedHash);
    expect(sessions.revokeSession).not.toHaveBeenCalled();
    expect(result.sessionId).toBe(sessionId);
    expect(result.refreshToken).not.toBe(refreshToken);
  });

  it('revokes the session and rejects when the conditional update affects 0 rows (lost race or reused token)', async () => {
    sessions.rotateRefreshTokenIfMatches.mockResolvedValue(false);
    const refreshToken = await issueRefreshToken();
    const csrfToken = auth.computeCsrfToken(sessionId);

    await expect(auth.refreshTokens(refreshToken, csrfToken)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sessions.revokeSession).toHaveBeenCalledWith(sessionId);
  });

  it('rejects a mismatched CSRF token before ever touching the session store', async () => {
    const refreshToken = await issueRefreshToken();

    await expect(auth.refreshTokens(refreshToken, 'wrong-csrf')).rejects.toBeInstanceOf(ForbiddenException);
    expect(sessions.rotateRefreshTokenIfMatches).not.toHaveBeenCalled();
  });

  it('never mints two identical refresh tokens for the same session, thanks to jti', async () => {
    const user = { id: userId, email: 'staff@example.test' } as any;
    const first = await (auth as any).issueTokens(user, sessionId);
    const second = await (auth as any).issueTokens(user, sessionId);

    expect(first.refreshToken).not.toBe(second.refreshToken);
    expect(first.refreshTokenHash).not.toBe(second.refreshTokenHash);
  });

  // Note: this only checks that AuthService calls the atomic primitive
  // correctly. Proving the UPDATE itself is race-free needs an integration
  // test against a real Postgres instance (two concurrent calls to
  // SessionService.rotateRefreshTokenIfMatches with the same expectedHash,
  // asserting exactly one resolves true) — a unit test with a mocked
  // repository can't exercise real database-level concurrency.
});
