import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Repository } from 'typeorm';
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
 * Stage 2 of Session Management: standalone service, not wired into
 * AuthService or the login/refresh/logout flows yet.
 */
@Injectable()
export class SessionService {
  constructor(
    @InjectRepository(Session)
    private readonly sessionRepository: Repository<Session>,
  ) {}

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

  async revokeSession(sessionId: string): Promise<void> {
    await this.sessionRepository.update({ id: sessionId }, { revokedAt: new Date() });
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.sessionRepository.update({ userId }, { revokedAt: new Date() });
  }
}
