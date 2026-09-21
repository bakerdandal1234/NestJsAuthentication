import {
    ForbiddenException,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { CustomerOAuthChallengeService } from './customer-oauth-challenge.service';
import { CustomerTwoFactorService } from './customer-two-factor.service';
import { CustomerAccountsService } from './customer-accounts.service';
import { CustomerExchangeService } from './customer-exchange.service';
import { CustomerSessionsService } from './customer-sessions.service';
import type {
    CustomerRequestContext,
    SafeCustomerSession,
} from './customer-sessions.service';
import { CustomerTokensService } from './customer-tokens.service';
import { CustomerAccount } from './entities/customer-account.entity';
import { CustomerSession } from './entities/customer-session.entity';
import type { CustomerGoogleProfile } from './interfaces/customer-google-profile.interface';
import type { CustomerPrincipal } from './interfaces/customer-principal.interface';
import {
    CUSTOMER_2FA_CHALLENGE_TTL_SECONDS,
    CUSTOMER_PENDING_EXCHANGE_PREFIX,
    CUSTOMER_REFRESH_TTL_SECONDS,
} from './customer-auth.constants';

export interface CustomerLoginHandoff {
    code: string;
    binding: string;
    expiresIn: number;
}

export interface CustomerSessionIssued {
    kind: 'session';
    accessToken: string;
    refreshToken: string;
    sessionId: string;
}

export interface CustomerTwoFactorRequired {
    kind: 'two-factor';
    challenge: string;
    expiresIn: number;
}

export type CustomerExchangeOutcome =
    | CustomerSessionIssued
    | CustomerTwoFactorRequired;

/**
 * Internal result of the refresh transaction. Failures are RETURNED rather
 * than thrown so the transaction can commit first — see refresh().
 */
type CustomerRefreshOutcome =
    | CustomerSessionIssued
    | { kind: 'rejected' }
    | { kind: 'reuse-detected'; sessionId: string };

/**
 * Internal result of the 2FA transaction. Account-level failed verification
 * bookkeeping still runs after commit. The independent challenge attempt
 * is already persisted before this transaction begins — see verifyTwoFactor().
 */
type CustomerTwoFactorOutcome =
    | CustomerSessionIssued
    | { kind: 'rejected' }
    | { kind: 'invalid-code'; accountId: string; currentAttempts: number };

/**
 * Orchestrates the customer login flow. It owns the ORDER of steps and the
 * security decisions between them; each individual concern lives in its own
 * collaborator:
 *
 *   - CustomerAccountsService  -> resolving the Google identity to an account
 *   - CustomerExchangeService  -> the one-time OAuth code / binding pair
 *   - CustomerOAuthChallengeService -> the separate pending 2FA store
 *   - CustomerSessionsService  -> customer_sessions + customer_login_history
 *   - CustomerTokensService    -> JWT signing/verification + CSRF derivation
 *   - CustomerCookiesService   -> cookie transport (controller-side only)
 *
 * Nothing here knows about HTTP, cookies or redirects: the controller adapts
 * these results to the wire.
 */
@Injectable()
export class CustomerAuthService {
    constructor(
        private readonly accountsService: CustomerAccountsService,
        private readonly exchange: CustomerExchangeService,
        private readonly sessions: CustomerSessionsService,
        private readonly tokens: CustomerTokensService,
        private readonly twoFactor: CustomerTwoFactorService,
        private readonly challenges: CustomerOAuthChallengeService,
    ) { }

    /**
     * Step 1, called from the Google callback. Resolves the account and mints
     * the code/binding pair. No token and no usable session yet: the row
     * created here carries a pending marker, not a refresh token hash.
     */
    async beginGoogleLogin(
        profile: CustomerGoogleProfile,
        context: CustomerRequestContext,
    ): Promise<CustomerLoginHandoff> {
        const account = await this.accountsService.resolveGoogleAccount(profile);

        // Locked / unverified accounts are stopped before anything is minted.
        this.assertLoginAllowed(account);

        const issued = this.exchange.issueCode();

        await this.sessions.createPending(
            issued.sessionId,
            account.id,
            issued.pendingHash,
            new Date(Date.now() + issued.expiresIn * 1000),
            context,
        );

        return {
            code: issued.code,
            binding: issued.binding,
            expiresIn: issued.expiresIn,
        };
    }

    /**
     * Step 2, called from the frontend callback page. Requires BOTH halves:
     * the code from the URL and the binding from the httpOnly cookie.
     *
     * Redeeming is a locked read-modify-write, so React StrictMode's double
     * invocation (or any replay) cannot redeem the same code twice — the
     * second attempt finds a replaced hash or a revoked exchange row.
     */
    async completeExchange(
        code: unknown,
        binding: unknown,
        context: CustomerRequestContext,
    ): Promise<CustomerExchangeOutcome> {
        if (!this.exchange.isCode(code) || !this.exchange.isBinding(binding)) {
            throw this.exchange.invalid();
        }

        const sessionId = this.exchange.sessionIdOf(code);
        const expectedHash = this.exchange.pendingHashFor(code, binding);

        return this.sessions.runInTransaction(
            async (manager): Promise<CustomerExchangeOutcome> => {
                const session = await this.sessions.lockById(manager, sessionId);

                if (
                    !session ||
                    !session.refreshTokenHash.startsWith(
                        CUSTOMER_PENDING_EXCHANGE_PREFIX,
                    ) ||
                    !this.exchange.matches(session.refreshTokenHash, expectedHash) ||
                    !this.isUsable(session)
                ) {
                    throw this.exchange.invalid();
                }

                const account = await this.lockAccount(manager, session.customerAccountId);

                // Re-checked here: the account may have been locked between the
                // Google callback and this request.
                this.assertLoginAllowed(account);

                if (account.isTwoFactorEnabled) {
                    if (!account.twoFactorSecret) {
                        // 2FA is on but no secret is stored, so the second
                        // factor can never be verified. Fail closed: no session
                        // is issued, and the pending row simply expires with the
                        // code (a revoke here would be rolled back by the throw
                        // anyway, and is pointless since this row can never
                        // become a session).
                        throw new ForbiddenException(
                            'Two-factor verification is unavailable for this account. Please contact support.',
                        );
                    }

                    // Commit challenge issuance and exchange consumption together.
                    // This row remains a revoked exchange placeholder; it is
                    // never promoted into the post-2FA authenticated session.
                    const challenge = await this.challenges.create(
                        account.id,
                        account.twoFactorSecret,
                        manager,
                    );
                    await this.sessions.revoke(session.id, manager);

                    return {
                        kind: 'two-factor',
                        challenge,
                        expiresIn: CUSTOMER_2FA_CHALLENGE_TTL_SECONDS,
                    };
                }

                return this.issueSession(manager, session, account, context, true);
            },
        );
    }

    /**
     * Step 3, only for accounts with 2FA enabled. The challenge cookie proves
     * Google already succeeded; the TOTP code proves the second factor. A
     * full session is issued only after both.
     */
    async verifyTwoFactor(
        challenge: unknown,
        code: string,
        context: CustomerRequestContext,
    ): Promise<CustomerSessionIssued> {
        // Count before opening the verification transaction. A wrong code,
        // account lockout or later rollback must not refund this attempt.
        const pending = await this.challenges.attempt(challenge);

        const outcome = await this.sessions.runInTransaction(
            async (manager): Promise<CustomerTwoFactorOutcome> => {
                const account = await this.lockAccount(
                    manager,
                    pending.customerAccountId,
                );

                this.assertLoginAllowed(account);

                if (
                    !account.isTwoFactorEnabled ||
                    !account.twoFactorSecret ||
                    this.challenges.fingerprint(account.twoFactorSecret) !== pending.secretFingerprint
                ) {
                    return { kind: 'rejected' };
                }

                const valid = this.twoFactor.verifyStoredCode(
                    account.twoFactorSecret,
                    code,
                );

                if (!valid) {
                    // Account lockout is updated AFTER this transaction commits.
                    // The dedicated challenge attempt was already counted before
                    // this transaction and survives either outcome. The challenge row is left
                    // intact on purpose so a mistyped code can be retried
                    // until the lockout or the 5-minute expiry stops it.
                    return {
                        kind: 'invalid-code',
                        accountId: account.id,
                        currentAttempts: account.failedLoginAttempts,
                    };
                }

                // Consume and create the new session in the same transaction.
                // A concurrent verifier cannot mint a second session; a failed
                // insert rolls consumption back so a fresh attempt can retry.
                await this.challenges.consume(pending.tokenHash, manager);
                await this.accountsService.clearVerificationLockout(
                    manager,
                    account.id,
                );

                return this.issueFreshSession(manager, account, context);
            },
        );

        if (outcome.kind === 'invalid-code') {
            // Both writes happen after the commit, on their own connections.
            await this.accountsService.registerFailedVerification(
                outcome.accountId,
                outcome.currentAttempts,
            );

            await this.sessions.recordLogin(
                outcome.accountId,
                false,
                context,
                'Invalid two-factor code',
            );

            throw new UnauthorizedException(
                'Invalid two-factor authentication code',
            );
        }

        if (outcome.kind === 'rejected') {
            throw this.exchange.invalid();
        }

        return outcome;
    }

    /**
     * Refresh with rotation + reuse detection. Requires the httpOnly refresh
     * cookie AND the X-CSRF-Token header derived from this session's id.
     */
    async refresh(
        refreshToken: string | undefined,
        csrfToken: string | undefined,
    ): Promise<CustomerSessionIssued> {
        if (!refreshToken) {
            throw this.tokens.invalidRefreshToken();
        }

        const claims = await this.tokens.verifyRefreshToken(refreshToken);

        if (!this.tokens.csrfMatches(claims.sessionId, csrfToken)) {
            throw new ForbiddenException('Invalid or missing CSRF token');
        }

        const presentedHash = this.tokens.hashRefreshToken(refreshToken);

        const outcome = await this.sessions.runInTransaction(
            async (manager): Promise<CustomerRefreshOutcome> => {
                const session = await this.sessions.lockById(
                    manager,
                    claims.sessionId,
                );

                if (
                    !session ||
                    session.customerAccountId !== claims.accountId ||
                    !this.isUsable(session) ||
                    this.isPending(session)
                ) {
                    return { kind: 'rejected' };
                }

                if (
                    !this.exchange.matches(session.refreshTokenHash, presentedHash)
                ) {
                    // An already-rotated (or forged) token. The revoke must
                    // NOT happen here: throwing (or returning) out of this
                    // transaction would roll the UPDATE back, and issuing it
                    // on another connection would block on the row lock this
                    // transaction still holds. It is done after the commit
                    // below instead.
                    return { kind: 'reuse-detected', sessionId: session.id };
                }

                const account = await this.lockAccount(manager, claims.accountId);

                this.assertLoginAllowed(account);

                // No expiresAt passed: rotation must not extend the
                // session's absolute lifetime.
                return this.issueSession(manager, session, account, {}, false);
            },
        );

        if (outcome.kind === 'reuse-detected') {
            await this.sessions.revoke(outcome.sessionId);

            throw this.tokens.invalidRefreshToken();
        }

        if (outcome.kind === 'rejected') {
            throw this.tokens.invalidRefreshToken();
        }

        return outcome;
    }

    /**
     * Revokes exactly one session — the caller's own. The access token
     * (verified by CustomerJwtAuthGuard) decides WHOSE session may be
     * revoked; the refresh cookie, when present, must agree with it.
     */
    async logout(
        principal: CustomerPrincipal,
        refreshToken: string | undefined,
    ): Promise<{ message: string }> {
        if (refreshToken) {
            const claims = await this.tokens.verifyRefreshToken(refreshToken);

            if (
                claims.accountId !== principal.accountId ||
                claims.sessionId !== principal.sessionId
            ) {
                throw this.tokens.invalidRefreshToken();
            }
        }

        await this.sessions.revoke(principal.sessionId);

        return { message: 'Logged out successfully' };
    }

    listSessions(principal: CustomerPrincipal): Promise<SafeCustomerSession[]> {
        return this.sessions.listActive(principal.accountId, principal.sessionId);
    }

    async revokeSession(
        principal: CustomerPrincipal,
        sessionId: string,
    ): Promise<{ message: string }> {
        await this.sessions.revokeOwned(principal.accountId, sessionId);

        return { message: 'Session revoked' };
    }

    generateTwoFactorSetup(
        principal: CustomerPrincipal,
    ): Promise<{
        qrCodeDataUrl: string;
        secret: string;
    }> {
        return this.twoFactor.generateSetup(principal);
    }

    enableTwoFactor(
        principal: CustomerPrincipal,
        code: string,
    ): Promise<{ message: string }> {
        return this.twoFactor.enable(principal, code);
    }

    disableTwoFactor(
        principal: CustomerPrincipal,
        code: string,
    ): Promise<{ message: string }> {
        return this.twoFactor.disable(principal, code);
    }

    computeCsrfToken(sessionId: string): string {
        return this.tokens.computeCsrfToken(sessionId);
    }

    // -------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------

    /**
     * A verified second factor starts a fresh device session, with a new id
     * and context from this request. No exchange placeholder is reused and
     * no temporary challenge value ever enters refreshTokenHash.
     */
    private async issueFreshSession(
        manager: EntityManager,
        account: CustomerAccount,
        context: CustomerRequestContext,
    ): Promise<CustomerSessionIssued> {
        const sessionId = randomUUID();
        const [accessToken, refreshToken] = await Promise.all([
            this.tokens.signAccessToken(account.id, sessionId),
            this.tokens.signRefreshToken(account.id, sessionId),
        ]);

        await this.sessions.createSession(
            manager,
            sessionId,
            account.id,
            this.tokens.hashRefreshToken(refreshToken),
            new Date(Date.now() + CUSTOMER_REFRESH_TTL_SECONDS * 1000),
            context,
        );
        await this.sessions.recordLogin(account.id, true, context, undefined, manager);

        return { kind: 'session', accessToken, refreshToken, sessionId };
    }

    /**
     * Turns a pending or rotating row into a live session: signs the token
     * pair and stores only the refresh token's digest.
     */
    private async issueSession(
        manager: EntityManager,
        session: CustomerSession,
        account: CustomerAccount,
        context: CustomerRequestContext,
        isNewLogin: boolean,
    ): Promise<CustomerSessionIssued> {
        const [accessToken, refreshToken] = await Promise.all([
            this.tokens.signAccessToken(account.id, session.id),
            this.tokens.signRefreshToken(account.id, session.id),
        ]);

        await this.sessions.replaceHash(
            manager,
            session,
            this.tokens.hashRefreshToken(refreshToken),
            isNewLogin
                ? new Date(Date.now() + CUSTOMER_REFRESH_TTL_SECONDS * 1000)
                : undefined,
        );

        if (isNewLogin) {
            await this.sessions.recordLogin(
                account.id,
                true,
                context,
                undefined,
                manager,
            );
        }

        return {
            kind: 'session',
            accessToken,
            refreshToken,
            sessionId: session.id,
        };
    }

    private async lockAccount(
        manager: EntityManager,
        accountId: string,
    ): Promise<CustomerAccount> {
        const account = await manager.getRepository(CustomerAccount).findOne({
            where: { id: accountId },
            lock: { mode: 'pessimistic_write' },
        });

        if (!account) {
            throw this.exchange.invalid();
        }

        return account;
    }

    /** A row is usable while it is neither revoked nor past its expiry. */
    private isUsable(session: CustomerSession): boolean {
        return !session.revokedAt && session.expiresAt.getTime() > Date.now();
    }

    /**
     * Only SHA-256 refresh digests represent established sessions. The
     * allowlist also rejects legacy pending markers during deployment,
     * without retaining the removed challenge-storage format.
     */
    private isPending(session: CustomerSession): boolean {
        return !/^[0-9a-f]{64}$/.test(session.refreshTokenHash);
    }

    /**
     * Gate every stage of the flow passes through. 2FA is deliberately NOT
     * refused here any more: it is a required extra step (see
     * verifyTwoFactor), not a dead end.
     */
    private assertLoginAllowed(account: CustomerAccount): void {
        if (!account.isEmailVerified) {
            throw new ForbiddenException('A verified email is required');
        }

        if (account.lockedUntil && account.lockedUntil.getTime() > Date.now()) {
            throw new ForbiddenException('Account is temporarily locked');
        }
    }
}
