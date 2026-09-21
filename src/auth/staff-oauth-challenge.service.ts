import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { LessThanOrEqual, Repository } from 'typeorm';
import { StaffOAuthChallenge } from './staff-oauth-challenge.entity';

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
    await this.repository.save(this.repository.create({
      tokenHash: this.fingerprint(token),
      userId,
      secretFingerprint: this.fingerprint(secret),
      expiresAt: new Date(Date.now() + STAFF_OAUTH_2FA_TTL_SECONDS * 1000),
      attempts: 0,
    }));
    return token;
  }

  // The database increments the attempt count atomically across app instances.
  async attempt(token: string | undefined): Promise<StaffOAuthChallenge> {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
      throw new UnauthorizedException('Invalid or expired two-factor challenge');
    }
    const result = await this.repository.createQueryBuilder()
      .update(StaffOAuthChallenge)
      .set({ attempts: () => '"attempts" + 1' })
      .where('"tokenHash" = :hash', { hash: this.fingerprint(token) })
      .andWhere('"expiresAt" > CURRENT_TIMESTAMP')
      .andWhere('"attempts" < 5')
      .returning('*')
      .execute();
    const challenge = result.raw[0] as StaffOAuthChallenge | undefined;
    if (!challenge) {
      throw new UnauthorizedException('Invalid or expired two-factor challenge');
    }
    return challenge;
  }

  // Only one successful verifier can consume a challenge, including concurrent requests.
  async consume(tokenHash: string): Promise<void> {
    const result = await this.repository.createQueryBuilder()
      .delete()
      .where('"tokenHash" = :hash', { hash: tokenHash })
      .andWhere('"expiresAt" > CURRENT_TIMESTAMP')
      .execute();
    if (result.affected !== 1) {
      throw new UnauthorizedException('Invalid or expired two-factor challenge');
    }
  }
}
