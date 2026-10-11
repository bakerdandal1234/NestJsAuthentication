import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions, Request } from 'express';
import { EntityManager, LessThanOrEqual, Repository } from 'typeorm';
import { OAuthState } from './oauth-state.entity';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
type OAuthProvider = OAuthState['provider'];
type StateStoredCallback = (error: unknown, state?: string) => void;
type StateVerifiedCallback = (error: unknown, verified?: boolean) => void;

@Injectable()
export class OAuthStateService {
  constructor(
    @InjectRepository(OAuthState)
    private readonly stateRepository: Repository<OAuthState>,
    private readonly configService: ConfigService,
  ) {}

  // Passport chooses the store/verify calling convention from each function's arity.
  forProvider(provider: OAuthProvider) {
    return {
      store: (request: Request, done: StateStoredCallback): void => {
        void this.createState(request, provider).then(
          (state) => done(null, state),
          done,
        );
      },
      verify: (
        request: Request,
        state: unknown,
        done: StateVerifiedCallback,
      ): void => {
        void this.consumeState(request, state, provider).then(
          () => done(null, true),
          done,
        );
      },
    };
  }

  private async createState(
    request: Request,
    provider: OAuthProvider,
  ): Promise<string> {
    const state = randomBytes(32).toString('hex');
    const browserToken = randomBytes(32).toString('hex');
    await this.stateRepository.delete({
      expiresAt: LessThanOrEqual(new Date()),
    });
    await this.stateRepository.save(
      this.stateRepository.create({
        stateHash: this.tokenHash(state),
        browserTokenHash: this.tokenHash(browserToken),
        provider,
        expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
      }),
    );
    request.res!.cookie(this.cookieName(provider), browserToken, {
      ...this.cookieOptions(),
      maxAge: OAUTH_STATE_TTL_MS,
    });
    return state;
  }

  private async consumeState(
    request: Request,
    state: unknown,
    provider: OAuthProvider,
  ): Promise<void> {
    const browserToken = request.cookies?.[this.cookieName(provider)];
    this.assertStateToken(state);
    this.assertStateToken(browserToken);
    await this.stateRepository.manager.transaction(async (transaction) => {
      const stateHash = this.tokenHash(state);
      await transaction.getRepository(OAuthState).findOne({
        select: { stateHash: true },
        where: { stateHash },
        lock: { mode: 'pessimistic_write' },
      });
      await this.consumeLockedState(
        transaction,
        stateHash,
        this.tokenHash(browserToken),
        provider,
      );
    });
    request.res!.clearCookie(this.cookieName(provider), this.cookieOptions());
  }

  private async consumeLockedState(
    transaction: EntityManager,
    stateHash: string,
    browserHash: string,
    provider: OAuthProvider,
  ): Promise<void> {
    const consumedState = await transaction
      .getRepository(OAuthState)
      .createQueryBuilder()
      .delete()
      .where('"stateHash" = :stateHash', { stateHash })
      .andWhere('"browserTokenHash" = :browserHash', { browserHash })
      .andWhere('"provider" = :provider', { provider })
      .andWhere('"expiresAt" > clock_timestamp()')
      .execute();
    if (consumedState.affected !== 1) {
      throw new UnauthorizedException('Invalid or expired OAuth state');
    }
  }

  private assertStateToken(token: unknown): asserts token is string {
    // Missing, empty, repeated-query and malformed tokens must fail before hashing or database access.
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
      throw new UnauthorizedException('Invalid or expired OAuth state');
    }
  }

  private tokenHash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private cookieName(provider: OAuthProvider): string {
    const prefix =
      this.configService.get<string>('NODE_ENV') === 'production'
        ? '__Host-'
        : '';
    return `${prefix}oauth_${provider}_state`;
  }

  private cookieOptions(): CookieOptions {
    // Host-only cookies resist sibling-domain fixation; Lax permits the provider's top-level callback.
    return {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: this.configService.get<string>('NODE_ENV') === 'production',
    };
  }
}
