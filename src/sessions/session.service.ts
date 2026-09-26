import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { isUUID } from 'class-validator';
import { Session } from './entities/session.entity';

/**
 * Data needed to open a new session, besides the userId it belongs to.
 * refreshTokenHash must already be hashed by the caller — the raw refresh
 * token itself is never stored.
 */
export interface CreateSessionContext {
  refreshTokenHash: string;
  userAgent?: string;
  ipAddress?: string;
  expiresAt: Date;
  revokedAt?: Date;
}

/**
 * Creates, validates, rotates and revokes staff authentication sessions.
 */
@Injectable()
export class SessionService {
  constructor(
    @InjectRepository(Session)
    private readonly sessionRepository: Repository<Session>,
  ) {}

  async requireActiveSession(sessionId: string, userId: string): Promise<Session> {
    if (
      typeof sessionId !== 'string' || !isUUID(sessionId) ||
      typeof userId !== 'string' || !isUUID(userId)
    ) {
      throw new UnauthorizedException('Invalid or expired session');
    }
    const session = await this.sessionRepository.findOne({
      where: { id: sessionId, userId },
    });
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Invalid or expired session');
    }
    return session;
  }

  async createSession(userId: string, context: CreateSessionContext): Promise<Session> {
    const session = this.sessionRepository.create({ userId, ...context });
    return this.sessionRepository.save(session);
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
      where: { userId,
        revokedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
       },
      order: { createdAt: 'DESC' },
    });
  }

  async rotateRefreshToken(sessionId: string, refreshTokenHash: string): Promise<Session> {
    const session = await this.findById(sessionId);
    session.refreshTokenHash = refreshTokenHash;
    session.lastUsedAt = new Date();
    return this.sessionRepository.save(session);
  }

  /**
   * Atomically rotates the refresh token hash only if the row still holds
   * `expectedHash` (and is not revoked/expired) at the moment of the
   * UPDATE. This is a single-statement compare-and-swap: the database
   * itself resolves the race, so two concurrent requests presenting the
   * same not-yet-rotated token can never both succeed — only one UPDATE
   * can match, the other affects 0 rows and gets `false` back. Requires
   * refreshTokenHash to be a deterministic hash (see AuthService.
   * hashRefreshToken()) since bcrypt's per-call random salt would never
   * equality-match here.
   */
  async rotateRefreshTokenIfMatches(
    sessionId: string,
    expectedHash: string,
    newHash: string,
  ): Promise<boolean> {
    const result = await this.sessionRepository
      .createQueryBuilder()
      .update(Session)
      .set({ refreshTokenHash: newHash, lastUsedAt: new Date() })
      .where('id = :sessionId', { sessionId })
      .andWhere('"refreshTokenHash" = :expectedHash', { expectedHash })
      .andWhere('"revokedAt" IS NULL')
      .andWhere('"expiresAt" > :now', { now: new Date() })
      .execute();

    return (result.affected ?? 0) > 0;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.sessionRepository.update({ id: sessionId }, { revokedAt: new Date() });
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.sessionRepository.update({ userId }, { revokedAt: new Date() });
  }
}
