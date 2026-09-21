import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as speakeasy from 'speakeasy';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';

const userId = '11111111-1111-4111-8111-111111111111';
const secret = 'JBSWY3DPEHPK3PXP';

describe('Staff OAuth two-factor login', () => {
  let user: any;
  let challenges: any;
  let users: any;
  let sessions: any;
  let service: AuthService;
  let complete: jest.SpyInstance;
  const config = new ConfigService({ FRONTEND_URL: 'http://localhost:5173' });
  const profile = { provider: 'google', providerId: 'google-id', email: 'user@example.test', emailVerified: true } as any;

  beforeEach(() => {
    user = { id: userId, isTwoFactorEnabled: true, twoFactorSecret: secret };
    challenges = {
      create: jest.fn().mockResolvedValue('opaque-challenge'),
      attempt: jest.fn().mockResolvedValue({ userId, tokenHash: 'hash', secretFingerprint: secret }),
      fingerprint: jest.fn((value) => value),
      consume: jest.fn().mockResolvedValue(undefined),
    };
    users = { findById: jest.fn().mockResolvedValue(user), recordLoginAttempt: jest.fn() };
    sessions = { createSession: jest.fn() };
    service = new AuthService(users, new JwtService(), config, {} as any, sessions, {} as any, challenges);
    jest.spyOn(service as any, 'resolveOAuthUser').mockResolvedValue(user);
    jest.spyOn(service as any, 'recordAttempt').mockResolvedValue(undefined);
    complete = jest.spyOn(service as any, 'completeOAuthLogin').mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh', sessionId: 'session', userId });
  });

  it.each(['google', 'github'])('requires 2FA before creating a %s session', async (provider) => {
    const result = await service.loginWithOAuth({ ...profile, provider }, {});
    expect(result).toEqual({ twoFactorRequired: true, challenge: 'opaque-challenge', expiresIn: 300 });
    expect(complete).not.toHaveBeenCalled();
    expect(sessions.createSession).not.toHaveBeenCalled();
  });

  it('preserves normal OAuth login when 2FA is disabled', async () => {
    user.isTwoFactorEnabled = false;
    await expect(service.loginWithOAuth(profile, {})).resolves.toMatchObject({ accessToken: 'access' });
    expect(challenges.create).not.toHaveBeenCalled();
  });

  it('consumes a valid challenge before issuing a session', async () => {
    const code = speakeasy.totp({ secret, encoding: 'base32' });
    await expect(service.verifyOAuthTwoFactor('challenge', code, {})).resolves.toMatchObject({ accessToken: 'access' });
    expect(challenges.consume.mock.invocationCallOrder[0]).toBeLessThan(complete.mock.invocationCallOrder[0]);
  });

  it('rejects incorrect codes without issuing a session or consuming the challenge', async () => {
    await expect(service.verifyOAuthTwoFactor('challenge', 'abcdef', {})).rejects.toBeInstanceOf(UnauthorizedException);
    expect(complete).not.toHaveBeenCalled();
    expect(challenges.consume).not.toHaveBeenCalled();
  });

  it.each(['expired', 'exhausted', 'missing'])('does not bypass an %s challenge', async () => {
    challenges.attempt.mockRejectedValue(new UnauthorizedException());
    await expect(service.verifyOAuthTwoFactor(undefined, '123456', {})).rejects.toBeInstanceOf(UnauthorizedException);
    expect(complete).not.toHaveBeenCalled();
  });

  it('rejects a replay or concurrent loser after successful TOTP verification', async () => {
    challenges.consume.mockRejectedValue(new UnauthorizedException());
    await expect(service.verifyOAuthTwoFactor('challenge', speakeasy.totp({ secret, encoding: 'base32' }), {})).rejects.toBeInstanceOf(UnauthorizedException);
    expect(complete).not.toHaveBeenCalled();
  });

  it('invalidates a pending challenge when the 2FA secret changes', async () => {
    user.twoFactorSecret = 'NEWSECRET';
    await expect(service.verifyOAuthTwoFactor('challenge', '123456', {})).rejects.toBeInstanceOf(UnauthorizedException);
    expect(complete).not.toHaveBeenCalled();
  });

  it('sets only a challenge cookie in the OAuth callback when 2FA is required', async () => {
    jest.spyOn(service, 'getAuthCookieSettings').mockReturnValue({ httpOnly: true, secure: false, sameSite: 'lax', path: '/v1/auth', maxAge: 1000 });
    const controller = new AuthController(service, config);
    const res: any = { cookie: jest.fn(), clearCookie: jest.fn(), redirect: jest.fn(), setHeader: jest.fn() };
    await controller.googleAuthCallback({ user: profile, headers: {} } as any, res);
    expect(res.cookie).toHaveBeenCalledTimes(1);
    expect(res.cookie).toHaveBeenCalledWith('staff_oauth_2fa', 'opaque-challenge', expect.objectContaining({ httpOnly: true }));
    expect(res.redirect).toHaveBeenCalledWith('http://localhost:5173/oauth/callback?twoFactorRequired=true');
  });

  it('rejects verification from another origin before attempting the challenge', async () => {
    const controller = new AuthController(service, config);
    await expect(controller.verifyOAuthTwoFactor({ code: '123456' }, { headers: { origin: 'https://other.example' } } as any, {} as any)).rejects.toThrow('Invalid request origin');
    expect(challenges.attempt).not.toHaveBeenCalled();
  });
});
