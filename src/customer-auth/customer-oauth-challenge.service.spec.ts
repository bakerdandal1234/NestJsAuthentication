import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CustomerOAuthChallengeService } from './customer-oauth-challenge.service';
import { CustomerOAuthChallenge } from './entities/customer-oauth-challenge.entity';
import { CustomerAccount } from './entities/customer-account.entity';
import {
  CUSTOMER_2FA_CHALLENGE_TTL_SECONDS,
  CUSTOMER_MAX_FAILED_VERIFICATIONS,
} from './customer-auth.constants';
import { AppDataSource } from '../config/data-source';
import typeormConfig from '../config/typeorm.config';

/** Repository boundaries and metadata only; never connects or runs migrations. */
describe('CustomerOAuthChallengeService', () => {
  let service: CustomerOAuthChallengeService;
  let repository: any;
  let builder: any;

  function queryBuilder() {
    const result: any = {};
    for (const name of [
      'update',
      'set',
      'where',
      'andWhere',
      'returning',
      'delete',
    ]) {
      result[name] = jest.fn().mockReturnValue(result);
    }
    result.execute = jest.fn();
    return result;
  }

  beforeEach(() => {
    builder = queryBuilder();
    repository = {
      delete: jest.fn(),
      create: jest.fn((value) => value),
      save: jest.fn(),
      createQueryBuilder: jest.fn(() => builder),
    };
    service = new CustomerOAuthChallengeService(repository);
  });

  it('stores digests instead of the raw challenge or encrypted account secret', async () => {
    const before = Date.now();
    const token = await service.create('customer-account', 'encrypted-secret');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const stored = repository.save.mock.calls[0][0];
    expect(stored).toMatchObject({
      customerAccountId: 'customer-account',
      attempts: 0,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      secretFingerprint: createHash('sha256')
        .update('encrypted-secret')
        .digest('hex'),
    });
    expect(stored.tokenHash).not.toBe(token);
    expect(stored.secretFingerprint).not.toBe('encrypted-secret');
    expect(stored.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + CUSTOMER_2FA_CHALLENGE_TTL_SECONDS * 1000,
    );
    expect(stored.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + CUSTOMER_2FA_CHALLENGE_TTL_SECONDS * 1000,
    );
  });

  it('enlists creation in the exchange transaction instead of a separate connection', async () => {
    const transactional = {
      delete: jest.fn(),
      create: jest.fn((value) => value),
      save: jest.fn(),
    };
    const manager: any = { getRepository: jest.fn(() => transactional) };
    await service.create('account-id', 'secret', manager);
    expect(manager.getRepository).toHaveBeenCalledWith(CustomerOAuthChallenge);
    expect(transactional.save).toHaveBeenCalledTimes(1);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    '',
    'short',
    'g'.repeat(64),
    '11111111-1111-4111-8111-111111111111.' + 'a'.repeat(64),
  ])(
    'rejects malformed or legacy challenge %s before querying',
    async (token) => {
      await expect(service.attempt(token)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(repository.createQueryBuilder).not.toHaveBeenCalled();
    },
  );

  it('atomically reserves an unexpired attempt below the limit', async () => {
    const stored = {
      customerAccountId: 'account',
      tokenHash: 'stored-hash',
      attempts: 1,
    };
    builder.execute.mockResolvedValue({ raw: [stored] });
    await expect(service.attempt('a'.repeat(64))).resolves.toBe(stored);
    expect(builder.update).toHaveBeenCalledWith(CustomerOAuthChallenge);
    expect(builder.andWhere).toHaveBeenCalledWith(
      '"expiresAt" > CURRENT_TIMESTAMP',
    );
    expect(builder.andWhere).toHaveBeenCalledWith('"attempts" < :limit', {
      limit: CUSTOMER_MAX_FAILED_VERIFICATIONS,
    });
    expect(builder.set.mock.calls[0][0].attempts()).toBe('"attempts" + 1');
    expect(builder.where).toHaveBeenCalledWith('"tokenHash" = :hash', {
      hash: service.fingerprint('a'.repeat(64)),
    });
  });

  it('rejects a missing, expired or exhausted row when the conditional update matches nothing', async () => {
    builder.execute.mockResolvedValue({ raw: [] });
    await expect(service.attempt('a'.repeat(64))).rejects.toThrow(
      'Invalid or expired login code',
    );
  });

  it('consumes using the fresh-session transaction manager', async () => {
    const transactionBuilder = queryBuilder();
    transactionBuilder.execute.mockResolvedValue({ affected: 1 });
    const manager: any = {
      getRepository: jest.fn(() => ({
        createQueryBuilder: () => transactionBuilder,
      })),
    };
    await service.consume('token-digest', manager);
    expect(transactionBuilder.where).toHaveBeenCalledWith(
      '"tokenHash" = :hash',
      { hash: 'token-digest' },
    );
    expect(transactionBuilder.andWhere).toHaveBeenCalledWith(
      '"expiresAt" > CURRENT_TIMESTAMP',
    );
    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('rejects a second consumer or an expired challenge', async () => {
    builder.execute.mockResolvedValue({ affected: 0 });
    await expect(service.consume('token-digest')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('Customer challenge entity registration', () => {
  it('is visible to runtime and CLI metadata with the requested schema', async () => {
    expect(AppDataSource.options.entities).toContain(CustomerOAuthChallenge);
    expect(typeormConfig().entities).toContain(CustomerOAuthChallenge);
    // buildMetadatas validates entity mappings without opening a connection.
    await (
      AppDataSource as unknown as { buildMetadatas(): Promise<void> }
    ).buildMetadatas();
    const metadata = AppDataSource.getMetadata(CustomerOAuthChallenge);
    expect(metadata.tableName).toBe('customer_oauth_challenges');
    expect(
      metadata.primaryColumns.map((column) => column.propertyName),
    ).toEqual(['tokenHash']);
    expect(metadata.findColumnWithPropertyName('customerAccountId')?.type).toBe(
      'uuid',
    );
    for (const name of ['tokenHash', 'secretFingerprint']) {
      expect(Number(metadata.findColumnWithPropertyName(name)?.length)).toBe(
        64,
      );
    }
    expect(metadata.findColumnWithPropertyName('expiresAt')?.type).toBe(
      'timestamptz',
    );
    expect(metadata.findColumnWithPropertyName('attempts')?.default).toBe(0);
    expect(
      metadata.indices.some((index) =>
        index.columns.some((column) => column.propertyName === 'expiresAt'),
      ),
    ).toBe(true);
    expect(metadata.foreignKeys[0].referencedEntityMetadata.target).toBe(
      CustomerAccount,
    );
    expect(metadata.foreignKeys[0].onDelete).toBe('CASCADE');
    expect(AppDataSource.isInitialized).toBe(false);
  });
});
