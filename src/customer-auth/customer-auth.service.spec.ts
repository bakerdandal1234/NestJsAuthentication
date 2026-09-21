import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CustomerAuthService } from './customer-auth.service';
import { CustomerAuthController } from './customer-auth.controller';
import { CustomerExchangeService } from './customer-exchange.service';
import {
  CUSTOMER_2FA_CHALLENGE_TTL_SECONDS,
  CUSTOMER_REFRESH_TTL_SECONDS,
} from './customer-auth.constants';

/** Flow regressions only: no database connection or schema changes. */
describe('Customer OAuth with dedicated 2FA challenges', () => {
  let service: CustomerAuthService;
  let exchange: CustomerExchangeService;
  let accounts: any;
  let account: any;
  let sessions: any;
  let tokens: any;
  let twoFactor: any;
  let challenges: any;
  let manager: any;
  let commit: jest.Mock;
  let handoff: ReturnType<CustomerExchangeService['issueCode']>;
  let pendingSession: any;
  const context = { ipAddress: '127.0.0.1', userAgent: 'test-browser' };
  const fingerprint = (s: string) =>
    createHash('sha256').update(s).digest('hex');

  beforeEach(() => {
    exchange = new CustomerExchangeService();
    handoff = exchange.issueCode();
    account = {
      id: '11111111-1111-4111-8111-111111111111',
      isEmailVerified: true,
      isTwoFactorEnabled: true,
      twoFactorSecret: 'encrypted-customer-secret',
      failedLoginAttempts: 2,
    };
    pendingSession = {
      id: handoff.sessionId,
      customerAccountId: account.id,
      refreshTokenHash: handoff.pendingHash,
      expiresAt: new Date(Date.now() + 120000),
    };
    manager = {
      getRepository: jest.fn(() => ({ findOne: jest.fn(async () => account) })),
    };
    commit = jest.fn();
    accounts = {
      resolveGoogleAccount: jest.fn(async () => account),
      clearVerificationLockout: jest.fn(),
      registerFailedVerification: jest.fn(),
    };
    sessions = {
      runInTransaction: jest.fn(async (work) => {
        const result = await work(manager);
        commit();
        return result;
      }),
      createPending: jest.fn(),
      lockById: jest.fn(async () => pendingSession),
      replaceHash: jest.fn(),
      revoke: jest.fn(async () => {
        pendingSession.revokedAt = new Date();
      }),
      createSession: jest.fn(),
      recordLogin: jest.fn(),
    };
    tokens = {
      signAccessToken: jest.fn(async () => 'access'),
      signRefreshToken: jest.fn(async () => 'refresh'),
      hashRefreshToken: jest.fn(fingerprint),
      verifyRefreshToken: jest.fn(async () => ({
        accountId: account.id,
        sessionId: pendingSession.id,
      })),
      csrfMatches: jest.fn(() => true),
      invalidRefreshToken: () => new UnauthorizedException('Invalid refresh'),
    };
    twoFactor = { verifyStoredCode: jest.fn(() => true) };
    challenges = {
      create: jest.fn(async () => 'a'.repeat(64)),
      fingerprint,
      attempt: jest.fn(async () => ({
        customerAccountId: account.id,
        tokenHash: 'b'.repeat(64),
        secretFingerprint: fingerprint('encrypted-customer-secret'),
      })),
      consume: jest.fn(),
    };
    service = new CustomerAuthService(
      accounts,
      exchange,
      sessions,
      tokens,
      twoFactor,
      challenges,
    );
  });

  it('keeps the Google callback code/binding handoff and pending exchange row', async () => {
    const result = await service.beginGoogleLogin({} as any, context);
    expect(exchange.isCode(result.code)).toBe(true);
    expect(exchange.isBinding(result.binding)).toBe(true);
    expect(sessions.createPending).toHaveBeenCalledWith(
      exchange.sessionIdOf(result.code),
      account.id,
      exchange.pendingHashFor(result.code, result.binding),
      expect.any(Date),
      context,
    );
    expect(challenges.create).not.toHaveBeenCalled();
    expect(tokens.signAccessToken).not.toHaveBeenCalled();
  });

  it('creates a separate challenge and revokes the redeemed exchange row in one transaction', async () => {
    await expect(
      service.completeExchange(handoff.code, handoff.binding, context),
    ).resolves.toEqual({
      kind: 'two-factor',
      challenge: 'a'.repeat(64),
      expiresIn: CUSTOMER_2FA_CHALLENGE_TTL_SECONDS,
    });
    expect(challenges.create).toHaveBeenCalledWith(
      account.id,
      account.twoFactorSecret,
      manager,
    );
    expect(sessions.revoke).toHaveBeenCalledWith(handoff.sessionId, manager);
    expect(pendingSession.refreshTokenHash).toBe(handoff.pendingHash);
    expect(sessions.replaceHash).not.toHaveBeenCalled();
    expect(sessions.createSession).not.toHaveBeenCalled();
    expect(tokens.signAccessToken).not.toHaveBeenCalled();
    await expect(
      service.completeExchange(handoff.code, handoff.binding, context),
    ).rejects.toThrow('Invalid or expired login code');
    expect(challenges.create).toHaveBeenCalledTimes(1);
  });

  it('still requires the original binding cookie', async () => {
    await expect(
      service.completeExchange(handoff.code, '0'.repeat(64), context),
    ).rejects.toThrow('Invalid or expired login code');
    expect(challenges.create).not.toHaveBeenCalled();
  });

  it('keeps the existing session exchange when 2FA is disabled', async () => {
    account.isTwoFactorEnabled = false;
    const result = await service.completeExchange(
      handoff.code,
      handoff.binding,
      context,
    );
    expect(result).toMatchObject({
      kind: 'session',
      sessionId: handoff.sessionId,
    });
    expect(sessions.replaceHash).toHaveBeenCalled();
    expect(challenges.create).not.toHaveBeenCalled();
    expect(sessions.revoke).not.toHaveBeenCalled();
  });

  it('creates a new session only after TOTP verification and successful consumption', async () => {
    const result = await service.verifyTwoFactor(
      'a'.repeat(64),
      '123456',
      context,
    );
    expect(result).toMatchObject({
      kind: 'session',
      accessToken: 'access',
      refreshToken: 'refresh',
    });
    expect(result.sessionId).not.toBe(handoff.sessionId);
    expect(sessions.lockById).not.toHaveBeenCalled();
    expect(twoFactor.verifyStoredCode).toHaveBeenCalledWith(
      account.twoFactorSecret,
      '123456',
    );
    expect(challenges.consume).toHaveBeenCalledWith('b'.repeat(64), manager);
    expect(sessions.createSession).toHaveBeenCalledWith(
      manager,
      result.sessionId,
      account.id,
      fingerprint('refresh'),
      expect.any(Date),
      context,
    );
    const expiry = sessions.createSession.mock.calls[0][4] as Date;
    expect(expiry.getTime() - Date.now()).toBeGreaterThan(
      CUSTOMER_REFRESH_TTL_SECONDS * 1000 - 5000,
    );
    expect(challenges.attempt.mock.invocationCallOrder[0]).toBeLessThan(
      sessions.runInTransaction.mock.invocationCallOrder[0],
    );
    expect(twoFactor.verifyStoredCode.mock.invocationCallOrder[0]).toBeLessThan(
      challenges.consume.mock.invocationCallOrder[0],
    );
    expect(challenges.consume.mock.invocationCallOrder[0]).toBeLessThan(
      tokens.signAccessToken.mock.invocationCallOrder[0],
    );
    expect(sessions.recordLogin).toHaveBeenCalledWith(
      account.id,
      true,
      context,
      undefined,
      manager,
    );
  });

  it('keeps failed-code accounting and audit, without consuming or creating a session', async () => {
    twoFactor.verifyStoredCode.mockReturnValue(false);
    await expect(
      service.verifyTwoFactor('a'.repeat(64), '000000', context),
    ).rejects.toThrow('Invalid two-factor authentication code');
    expect(accounts.registerFailedVerification).toHaveBeenCalledWith(
      account.id,
      2,
    );
    expect(commit.mock.invocationCallOrder[0]).toBeLessThan(
      accounts.registerFailedVerification.mock.invocationCallOrder[0],
    );
    expect(sessions.recordLogin).toHaveBeenCalledWith(
      account.id,
      false,
      context,
      'Invalid two-factor code',
    );
    expect(challenges.consume).not.toHaveBeenCalled();
    expect(sessions.createSession).not.toHaveBeenCalled();
    expect(tokens.signAccessToken).not.toHaveBeenCalled();
  });

  it.each([
    'changed-secret',
    'disabled',
    'missing-secret',
    'locked',
    'unverified',
    'missing-account',
  ])('rejects %s before creating a session', async (state) => {
    if (state === 'changed-secret') account.twoFactorSecret = 'replaced-secret';
    if (state === 'disabled') account.isTwoFactorEnabled = false;
    if (state === 'missing-secret') account.twoFactorSecret = null;
    if (state === 'locked') account.lockedUntil = new Date(Date.now() + 60000);
    if (state === 'unverified') account.isEmailVerified = false;
    if (state === 'missing-account')
      manager.getRepository.mockReturnValue({
        findOne: jest.fn(async () => null),
      });
    await expect(
      service.verifyTwoFactor('a'.repeat(64), '123456', context),
    ).rejects.toThrow();
    expect(challenges.consume).not.toHaveBeenCalled();
    expect(sessions.createSession).not.toHaveBeenCalled();
  });

  it('rejects invalid, expired or exhausted challenges before looking up an account', async () => {
    challenges.attempt.mockRejectedValue(exchange.invalid());
    await expect(
      service.verifyTwoFactor(undefined, '123456', context),
    ).rejects.toThrow('Invalid or expired login code');
    expect(sessions.runInTransaction).not.toHaveBeenCalled();
  });

  it('cannot issue a second session when consumption loses a replay race', async () => {
    challenges.consume.mockRejectedValue(exchange.invalid());
    await expect(
      service.verifyTwoFactor('a'.repeat(64), '123456', context),
    ).rejects.toThrow();
    expect(sessions.createSession).not.toHaveBeenCalled();
    expect(tokens.signAccessToken).not.toHaveBeenCalled();
  });

  it('lets a fresh-session write failure roll back the verification transaction', async () => {
    sessions.createSession.mockRejectedValue(new Error('session write failed'));
    await expect(
      service.verifyTwoFactor('a'.repeat(64), '123456', context),
    ).rejects.toThrow('session write failed');
    expect(commit).not.toHaveBeenCalled();
    expect(sessions.recordLogin).not.toHaveBeenCalled();
  });

  it('rejects a legacy pending row during refresh', async () => {
    pendingSession.refreshTokenHash = '2fa:' + 'f'.repeat(64);
    await expect(service.refresh('refresh', 'csrf')).rejects.toThrow(
      'Invalid refresh',
    );
    expect(tokens.signAccessToken).not.toHaveBeenCalled();
  });

  it('keeps the external twoFactor cookie and response contract', async () => {
    const cookies: any = {
      set: jest.fn(),
      clear: jest.fn(),
      read: jest.fn(() => handoff.binding),
      setSessionCookies: jest.fn(),
    };
    const controller = new CustomerAuthController(service, cookies, {} as any);
    const req: any = {
      headers: { 'user-agent': context.userAgent },
      ip: context.ipAddress,
    };
    const res: any = { setHeader: jest.fn() };
    await expect(
      controller.exchangeCode({ code: handoff.code }, req, res),
    ).resolves.toEqual({
      twoFactorRequired: true,
      expiresIn: CUSTOMER_2FA_CHALLENGE_TTL_SECONDS,
    });
    expect(cookies.set).toHaveBeenCalledWith(
      res,
      'twoFactor',
      'a'.repeat(64),
      CUSTOMER_2FA_CHALLENGE_TTL_SECONDS * 1000,
    );
    expect(cookies.setSessionCookies).not.toHaveBeenCalled();
    cookies.read.mockReturnValue('a'.repeat(64));
    jest.spyOn(service, 'computeCsrfToken').mockReturnValue('csrf');
    await expect(
      controller.verifyTwoFactor({ code: '123456' }, req, res),
    ).resolves.toEqual({ accessToken: 'access' });
    expect(cookies.clear).toHaveBeenCalledWith(res, 'twoFactor');
    expect(cookies.setSessionCookies).toHaveBeenCalledWith(
      res,
      'refresh',
      'csrf',
    );
  });
});
