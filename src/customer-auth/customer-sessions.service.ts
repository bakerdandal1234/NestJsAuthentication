import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { CustomerLoginHistory } from './entities/customer-login-history.entity';
import { CustomerSession } from './entities/customer-session.entity';
import {
  CUSTOMER_PENDING_2FA_PREFIX,
  CUSTOMER_PENDING_EXCHANGE_PREFIX,
} from './customer-auth.constants';

export interface CustomerRequestContext {
  ipAddress?: string;
  userAgent?: string;
}

/** Shape safe to return to a customer listing their own devices. */
export interface SafeCustomerSession {
  id: string;
  userAgent?: string;
  ipAddress?: string;
  createdAt: Date;
  lastUsedAt?: Date;
  expiresAt: Date;
  current: boolean;
}

/**
 * Persistence for customer sessions and customer login history.
 *
 * Responsibility: the customer_sessions / customer_login_history tables and
 * nothing else. It is a deliberately separate service from the staff
 * SessionService rather than a shared abstraction over both: the two stores
 * have different tables, different owner columns and different lifecycles,
 * so a shared base class would only be a place for staff and customer rules
 * to leak into each other.
 *
 * Isolation is structural, not a check: every method here is bound to
 * CustomerSession, and every account-facing method takes the accountId from
 * the verified customer principal. There is no code path through this
 * service that can reach a staff session row.
 */
@Injectable()
export class CustomerSessionsService {
  constructor(private readonly dataSource: DataSource) {}

  /** Runs `work` inside one transaction — used for every read-modify-write. */
  runInTransaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(work);
  }

  /**
   * Creates the "pending" row a login starts as: an id, an owner, and a
   * placeholder hash that is NOT a refresh token (see the pending prefixes).
   * No access or refresh token exists at this point.
   */
  createPending(
    sessionId: string,
    accountId: string,
    pendingHash: string,
    expiresAt: Date,
    context: CustomerRequestContext,
  ): Promise<CustomerSession> {
    const repository = this.repository();

    return repository.save(
      repository.create({
        id: sessionId,
        customerAccountId: accountId,
        refreshTokenHash: pendingHash,
        expiresAt,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      }),
    );
  }

  /** Row-level lock so two concurrent redemptions can never both succeed. */
  lockById(
    manager: EntityManager,
    sessionId: string,
  ): Promise<CustomerSession | null> {
    return manager.getRepository(CustomerSession).findOne({
      where: { id: sessionId },
      lock: { mode: 'pessimistic_write' },
    });
  }

  /**
   * Swaps the stored hash. This single operation is what consumes a code,
   * consumes a challenge, and rotates a refresh token — the old value stops
   * matching the moment it is replaced, which is what "single use" means
   * here. `expiresAt` is only passed when the session's lifetime genuinely
   * changes (never on plain rotation, so a session keeps an absolute expiry).
   */
  async replaceHash(
    manager: EntityManager,
    session: CustomerSession,
    refreshTokenHash: string,
    expiresAt?: Date,
  ): Promise<void> {
    session.refreshTokenHash = refreshTokenHash;
    session.lastUsedAt = new Date();

    if (expiresAt) {
      session.expiresAt = expiresAt;
    }

    await manager.getRepository(CustomerSession).save(session);
  }

  async revoke(sessionId: string, manager?: EntityManager): Promise<void> {
    await this.repository(manager).update(
      { id: sessionId },
      { revokedAt: new Date() },
    );
  }

  async revokeAll(accountId: string): Promise<void> {
    await this.repository().update(
      { customerAccountId: accountId },
      { revokedAt: new Date() },
    );
  }

  /**
   * Active, fully-established sessions for one account. Pending rows (an
   * unredeemed code, an unfinished 2FA challenge) are excluded: they are not
   * devices the customer is logged in on.
   */
  async listActive(
    accountId: string,
    currentSessionId: string,
  ): Promise<SafeCustomerSession[]> {
    const sessions = await this.repository()
      .createQueryBuilder('session')
      .where('session.customerAccountId = :accountId', { accountId })
      .andWhere('session.revokedAt IS NULL')
      .andWhere('session.expiresAt > :now', { now: new Date() })
      .andWhere('session.refreshTokenHash NOT LIKE :pendingExchange', {
        pendingExchange: `${CUSTOMER_PENDING_EXCHANGE_PREFIX}%`,
      })
      .andWhere('session.refreshTokenHash NOT LIKE :pending2fa', {
        pending2fa: `${CUSTOMER_PENDING_2FA_PREFIX}%`,
      })
      .orderBy('session.createdAt', 'DESC')
      .getMany();

    return sessions.map((session) => ({
      id: session.id,
      userAgent: session.userAgent,
      ipAddress: session.ipAddress,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.expiresAt,
      current: session.id === currentSessionId,
    }));
  }

  /**
   * Revokes one session the caller owns. A session id belonging to anyone
   * else — including any staff session id, which does not exist in this
   * table at all — is reported as not found rather than confirmed.
   */
  async revokeOwned(accountId: string, sessionId: string): Promise<void> {
    const session = await this.repository().findOne({
      where: { id: sessionId, customerAccountId: accountId },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    await this.revoke(session.id);
  }

  async recordLogin(
    accountId: string,
    success: boolean,
    context: CustomerRequestContext,
    failureReason?: string,
    manager?: EntityManager,
  ): Promise<void> {
    await (manager ?? this.dataSource.manager)
      .getRepository(CustomerLoginHistory)
      .insert({
        customerAccountId: accountId,
        success,
        failureReason,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      });
  }

  private repository(manager?: EntityManager): Repository<CustomerSession> {
    return (manager ?? this.dataSource.manager).getRepository(CustomerSession);
  }
}
