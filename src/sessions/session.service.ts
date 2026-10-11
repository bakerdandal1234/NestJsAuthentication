import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, MoreThan, Repository } from 'typeorm';
import { isUUID } from 'class-validator';
import { Session } from './entities/session.entity';

interface OAuthCodeConsumption {
  sessionId: string;
  userId: string;
  codeHash: string;
  refreshTokenHash: string;
}

/**
 * Validates, rotates and revokes authentication sessions.
 */
@Injectable()
export class SessionService {
  constructor(
    @InjectRepository(Session)
    private readonly sessionRepository: Repository<Session>,
  ) {}

  async requireActiveSession(
    sessionId: string,
    userId: string,
  ): Promise<Session> {
    if (
      typeof sessionId !== 'string' ||
      !isUUID(sessionId) ||
      typeof userId !== 'string' ||
      !isUUID(userId)
    ) {
      throw new UnauthorizedException('Invalid or expired session');
    }
    const session = await this.sessionRepository.findOne({
      where: { id: sessionId, userId },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now()
    ) {
      throw new UnauthorizedException('Invalid or expired session');
    }
    return session;
  }

  async storeOAuthExchangeCode(
    sessionId: string,
    userId: string,
    codeHash: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.sessionRepository.manager.transaction(async (transaction) => {
      await this.lockSession(transaction, sessionId);
      const updatedSession = await this.activeSessionUpdate(
        transaction,
        sessionId,
      )
        .set({
          oauthExchangeCodeHash: codeHash,
          oauthExchangeCodeExpiresAt: expiresAt,
        })
        .andWhere('"userId" = :userId', { userId })
        .andWhere(':codeExpiresAt > clock_timestamp()', {
          codeExpiresAt: expiresAt,
        })
        .execute();
      if (updatedSession.affected !== 1) {
        throw new UnauthorizedException('Invalid or expired session');
      }
    });
  }

  async consumeOAuthExchangeCode(
    consumption: OAuthCodeConsumption,
  ): Promise<void> {
    await this.sessionRepository.manager.transaction(async (transaction) => {
      await this.lockSession(transaction, consumption.sessionId);
      const consumedCode = await this.activeSessionUpdate(
        transaction,
        consumption.sessionId,
      )
        .set({
          oauthExchangeCodeHash: () => 'NULL',
          oauthExchangeCodeExpiresAt: () => 'NULL',
        })
        .andWhere('"userId" = :userId', consumption)
        .andWhere('"oauthExchangeCodeHash" = :codeHash')
        .andWhere('"refreshTokenHash" = :refreshTokenHash')
        .andWhere('"oauthExchangeCodeExpiresAt" > clock_timestamp()')
        .execute();
      if (consumedCode.affected !== 1) {
        throw new UnauthorizedException('Invalid or expired code');
      }
    });
  }

  async findById(id: string): Promise<Session> {
    const session = await this.sessionRepository.findOne({ where: { id } });
    if (!session) {
      throw new NotFoundException('Session not found');
    }
    return session;
  }

  findByTokenHash(refreshTokenHash: string): Promise<Session | null> {
    return this.sessionRepository.findOne({ where: { refreshTokenHash } });
  }

  getUserSessions(userId: string): Promise<Session[]> {
    return this.sessionRepository.find({
      where: { userId, revokedAt: IsNull(), expiresAt: MoreThan(new Date()) },
      order: { createdAt: 'DESC' },
    });
  }

  async rotateRefreshTokenIfMatches(
    sessionId: string,
    expectedHash: string,
    newHash: string,
  ): Promise<boolean> {
    return this.sessionRepository.manager.transaction(async (transaction) => {
      await this.lockSession(transaction, sessionId);
      const rotatedSession = await this.activeSessionUpdate(
        transaction,
        sessionId,
      )
        .set({
          refreshTokenHash: newHash,
          lastUsedAt: () => 'clock_timestamp()',
        })
        .andWhere('"refreshTokenHash" = :expectedHash', { expectedHash })
        .execute();
      return rotatedSession.affected === 1;
    });
  }

  private async lockSession(
    transaction: EntityManager,
    sessionId: string,
  ): Promise<void> {
    // Expiry must be checked after the wait, even when the lock holder made no update.
    await transaction.getRepository(Session).findOne({
      select: { id: true },
      where: { id: sessionId },
      lock: { mode: 'pessimistic_write' },
    });
  }

  private activeSessionUpdate(transaction: EntityManager, sessionId: string) {
    return transaction
      .getRepository(Session)
      .createQueryBuilder()
      .update(Session)
      .where('id = :sessionId', { sessionId })
      .andWhere('"revokedAt" IS NULL')
      .andWhere('"expiresAt" > clock_timestamp()');
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.sessionRepository.update(
      { id: sessionId },
      { revokedAt: new Date() },
    );
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.sessionRepository.update({ userId }, { revokedAt: new Date() });
  }
}
