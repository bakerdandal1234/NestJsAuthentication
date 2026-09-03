import { Controller, Get, Delete, Param, NotFoundException } from '@nestjs/common';
import { SessionService } from './session.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Session } from './entities/session.entity';

/**
 * Explicit whitelist of fields safe to return to the client.
 * refreshTokenHash (and the `user` relation) are intentionally never
 * included here — this project has no ClassSerializerInterceptor, so
 * @Exclude() decorators on the entity alone would NOT strip them.
 */
interface SafeSession {
  id: string;
  userAgent?: string;
  ipAddress?: string;
  createdAt: Date;
  lastUsedAt?: Date;
  expiresAt: Date;
  revokedAt?: Date;
}

function toSafeSession(session: Session): SafeSession {
  const { id, userAgent, ipAddress, createdAt, lastUsedAt, expiresAt, revokedAt } = session;
  return { id, userAgent, ipAddress, createdAt, lastUsedAt, expiresAt, revokedAt };
}

/**
 * Stage 6 of Session Management: lets a user view and manage their own
 * sessions only. Every route is scoped to @CurrentUser('id') — there is
 * no way to reach another user's session through this controller.
 */
@Controller('sessions')
export class SessionController {
  constructor(private readonly sessionService: SessionService) {}

  @Get()
  async getSessions(@CurrentUser('id') userId: string): Promise<SafeSession[]> {
    const sessions = await this.sessionService.getUserSessions(userId);
    return sessions.map(toSafeSession);
  }

  @Delete(':id')
  async revokeSession(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ): Promise<{ message: string }> {
    const session = await this.sessionService.findById(id);

    if (session.userId !== userId) {
      // Same response as "not found" — never confirm that a session id
      // belonging to someone else exists.
      throw new NotFoundException('Session not found');
    }

    await this.sessionService.revokeSession(id);
    return { message: 'Session revoked' };
  }

  @Delete()
  async revokeAllSessions(@CurrentUser('id') userId: string): Promise<{ message: string }> {
    await this.sessionService.revokeAllSessions(userId);
    return { message: 'All sessions revoked' };
  }
}
