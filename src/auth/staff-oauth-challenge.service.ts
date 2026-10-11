import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { EntityManager, LessThanOrEqual, Repository } from 'typeorm';
import {
  StaffOAuthChallenge,
  STAFF_OAUTH_2FA_MAX_ATTEMPTS,
} from './staff-oauth-challenge.entity';

export const STAFF_OAUTH_2FA_TTL_SECONDS = 300;

@Injectable()
export class StaffOAuthChallengeService {
  constructor(
    @InjectRepository(StaffOAuthChallenge)
    private readonly repository: Repository<StaffOAuthChallenge>,
  ) {}

  fingerprint(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  async create(userId: string, secret: string): Promise<string> {
    const token = randomBytes(32).toString('hex');
    await this.repository.delete({ expiresAt: LessThanOrEqual(new Date()) });
    await this.repository.save(
      this.repository.create({
        tokenHash: this.fingerprint(token),
        userId,
        secretFingerprint: this.fingerprint(secret),
        expiresAt: new Date(Date.now() + STAFF_OAUTH_2FA_TTL_SECONDS * 1000),
        attempts: 0,
      }),
    );
    return token;
  }

  async attempt(token: string | undefined): Promise<StaffOAuthChallenge> {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
      throw new UnauthorizedException(
        'Invalid or expired two-factor challenge',
      );
    }
    const tokenHash = this.fingerprint(token);
    return this.repository.manager.transaction(async (transaction) => {
      await transaction.getRepository(StaffOAuthChallenge).findOne({
        select: { tokenHash: true },
        where: { tokenHash },
        lock: { mode: 'pessimistic_write' },
      });
      return this.incrementChallengeAttempt(transaction, tokenHash);
    });
  }

  private async incrementChallengeAttempt(
    transaction: EntityManager,
    tokenHash: string,
  ): Promise<StaffOAuthChallenge> {
    const attemptedChallenge = await transaction
      .getRepository(StaffOAuthChallenge)
      .createQueryBuilder()
      .update(StaffOAuthChallenge)
      .set({ attempts: () => '"attempts" + 1' })
      .where('"tokenHash" = :hash', { hash: tokenHash })
      .andWhere('"expiresAt" > clock_timestamp()')
      .andWhere('"attempts" < :maxAttempts', {
        maxAttempts: STAFF_OAUTH_2FA_MAX_ATTEMPTS,
      })
      .returning('*')
      .execute();
    const challenge = attemptedChallenge.raw[0] as
      StaffOAuthChallenge | undefined;
    if (!challenge) {
      throw new UnauthorizedException(
        'Invalid or expired two-factor challenge',
      );
    }
    return challenge;
  }
}
