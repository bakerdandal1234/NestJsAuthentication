import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { EntityManager, LessThanOrEqual, Repository } from 'typeorm';

import {
  CUSTOMER_2FA_CHALLENGE_TTL_SECONDS,
  CUSTOMER_CHALLENGE_PATTERN,
  CUSTOMER_MAX_FAILED_VERIFICATIONS,
} from './customer-auth.constants';
import { CustomerOAuthChallenge } from './entities/customer-oauth-challenge.entity';

/**
 * Customer-only persistence for the second-factor handoff. Mirrors the
 * staff challenge lifecycle without sharing its table, tokens or owner ids.
 *
 * create()/consume() accept the caller's transaction manager: issuing a
 * challenge must commit with consuming the OAuth exchange, and consuming
 * a challenge must commit with creating the fresh authenticated session.
 * attempt() deliberately commits separately so failed verification or a
 * later rollback can never erase the challenge's attempt counter.
 */
@Injectable()
export class CustomerOAuthChallengeService {
  constructor(
    @InjectRepository(CustomerOAuthChallenge)
    private readonly repository: Repository<CustomerOAuthChallenge>,
  ) {}

  /** SHA-256 is appropriate for a random 256-bit token, not a password. */
  fingerprint(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  /**
   * Returns the opaque cookie value and persists only its digest. The
   * encrypted account secret is fingerprinted as stored; TOTP decryption
   * remains exclusively CustomerTwoFactorService's responsibility.
   */
  async create(
    customerAccountId: string,
    secret: string,
    manager?: EntityManager,
  ): Promise<string> {
    const repository = this.repositoryFor(manager);
    const token = randomBytes(32).toString('hex');

    await repository.delete({ expiresAt: LessThanOrEqual(new Date()) });
    await repository.save(
      repository.create({
        tokenHash: this.fingerprint(token),
        customerAccountId,
        secretFingerprint: this.fingerprint(secret),
        expiresAt: new Date(
          Date.now() + CUSTOMER_2FA_CHALLENGE_TTL_SECONDS * 1000,
        ),
        attempts: 0,
      }),
    );

    return token;
  }

  /**
   * Reserves one verification attempt with an atomic UPDATE. Separate app
   * instances cannot read the same old counter and bypass the limit. No
   * account id is accepted from the client: ownership comes from this row.
   */
  async attempt(token: unknown): Promise<CustomerOAuthChallenge> {
    if (typeof token !== 'string' || !CUSTOMER_CHALLENGE_PATTERN.test(token)) {
      throw this.invalid();
    }

    const result = await this.repository
      .createQueryBuilder()
      .update(CustomerOAuthChallenge)
      .set({ attempts: () => '"attempts" + 1' })
      .where('"tokenHash" = :hash', { hash: this.fingerprint(token) })
      .andWhere('"expiresAt" > CURRENT_TIMESTAMP')
      .andWhere('"attempts" < :limit', {
        limit: CUSTOMER_MAX_FAILED_VERIFICATIONS,
      })
      .returning('*')
      .execute();

    const challenge = result.raw[0] as CustomerOAuthChallenge | undefined;
    if (!challenge) {
      throw this.invalid();
    }

    return challenge;
  }

  /**
   * A conditional DELETE makes consumption single-use even if two correct
   * codes race. Within the caller's transaction, a failed session write
   * restores the challenge while the separately counted attempt remains.
   */
  async consume(tokenHash: string, manager?: EntityManager): Promise<void> {
    const result = await this.repositoryFor(manager)
      .createQueryBuilder()
      .delete()
      .where('"tokenHash" = :hash', { hash: tokenHash })
      .andWhere('"expiresAt" > CURRENT_TIMESTAMP')
      .execute();

    if (result.affected !== 1) {
      throw this.invalid();
    }
  }

  private repositoryFor(
    manager?: EntityManager,
  ): Repository<CustomerOAuthChallenge> {
    return manager
      ? manager.getRepository(CustomerOAuthChallenge)
      : this.repository;
  }

  /** Preserve the customer's existing generic rejection response. */
  private invalid(): UnauthorizedException {
    return new UnauthorizedException('Invalid or expired login code');
  }
}
