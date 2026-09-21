import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'crypto';
import * as QRCode from 'qrcode';
import * as speakeasy from 'speakeasy';
import { DataSource, EntityManager } from 'typeorm';

import { CustomerAccountsService } from './customer-accounts.service';
import { CustomerAccount } from './entities/customer-account.entity';
import type { CustomerPrincipal } from './interfaces/customer-principal.interface';

interface TwoFactorSetup {
  qrCodeDataUrl: string;
  secret: string;
}

type VerificationOutcome =
  | { valid: true }
  | {
      valid: false;
      accountId: string;
      currentAttempts: number;
    };

@Injectable()
export class CustomerTwoFactorService {
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly accountsService: CustomerAccountsService,
  ) {
    const configuredKey = this.config.getOrThrow<string>(
      'CUSTOMER_2FA_ENCRYPTION_KEY',
    );

    const decodedKey = Buffer.from(configuredKey, 'base64');

    if (decodedKey.length !== 32) {
      throw new Error(
        'CUSTOMER_2FA_ENCRYPTION_KEY must be exactly 32 bytes encoded as Base64',
      );
    }

    this.encryptionKey = decodedKey;
  }

  async generateSetup(
    principal: CustomerPrincipal,
  ): Promise<TwoFactorSetup> {
    const generated = await this.dataSource.transaction(
      async (manager) => {
        const account = await this.lockAccount(
          manager,
          principal.accountId,
        );

        this.assertAccountAvailable(account);

        if (account.isTwoFactorEnabled) {
          throw new ConflictException(
            'Two-factor authentication is already enabled',
          );
        }

        const secret = speakeasy.generateSecret({
          length: 20,
          issuer: 'FlowDesk',
          name: `FlowDesk (${account.email})`,
        });

        if (!secret.base32 || !secret.otpauth_url) {
          throw new Error(
            'Unable to generate two-factor authentication secret',
          );
        }

        account.twoFactorSecret = this.encrypt(secret.base32);
        account.isTwoFactorEnabled = false;

        await manager.getRepository(CustomerAccount).save(account);

        return {
          secret: secret.base32,
          otpauthUrl: secret.otpauth_url,
        };
      },
    );

    return {
      secret: generated.secret,
      qrCodeDataUrl: await QRCode.toDataURL(generated.otpauthUrl),
    };
  }

  async enable(
    principal: CustomerPrincipal,
    code: string,
  ): Promise<{ message: string }> {
    const outcome = await this.dataSource.transaction(
      async (manager): Promise<VerificationOutcome> => {
        const account = await this.lockAccount(
          manager,
          principal.accountId,
        );

        this.assertAccountAvailable(account);

        if (account.isTwoFactorEnabled) {
          throw new ConflictException(
            'Two-factor authentication is already enabled',
          );
        }

        if (!account.twoFactorSecret) {
          throw new BadRequestException(
            'Generate a two-factor setup before enabling it',
          );
        }

        if (!this.verifyStoredCode(account.twoFactorSecret, code)) {
          return {
            valid: false,
            accountId: account.id,
            currentAttempts: account.failedLoginAttempts,
          };
        }

        await manager
          .createQueryBuilder()
          .update(CustomerAccount)
          .set({
            isTwoFactorEnabled: true,
            failedLoginAttempts: 0,
            lockedUntil: () => 'NULL',
          })
          .where('id = :accountId', { accountId: account.id })
          .execute();

        return { valid: true };
      },
    );

    await this.rejectInvalidCode(outcome);

    return {
      message: 'Two-factor authentication is now enabled',
    };
  }

  async disable(
    principal: CustomerPrincipal,
    code: string,
  ): Promise<{ message: string }> {
    const outcome = await this.dataSource.transaction(
      async (manager): Promise<VerificationOutcome> => {
        const account = await this.lockAccount(
          manager,
          principal.accountId,
        );

        this.assertAccountAvailable(account);

        if (
          !account.isTwoFactorEnabled ||
          !account.twoFactorSecret
        ) {
          throw new BadRequestException(
            'Two-factor authentication is not enabled',
          );
        }

        if (!this.verifyStoredCode(account.twoFactorSecret, code)) {
          return {
            valid: false,
            accountId: account.id,
            currentAttempts: account.failedLoginAttempts,
          };
        }

        await manager
          .createQueryBuilder()
          .update(CustomerAccount)
          .set({
            twoFactorSecret: () => 'NULL',
            isTwoFactorEnabled: false,
            failedLoginAttempts: 0,
            lockedUntil: () => 'NULL',
          })
          .where('id = :accountId', { accountId: account.id })
          .execute();

        return { valid: true };
      },
    );

    await this.rejectInvalidCode(outcome);

    return {
      message: 'Two-factor authentication has been disabled',
    };
  }

  verifyStoredCode(encryptedSecret: string, code: string): boolean {
    const secret = this.decrypt(encryptedSecret);

    return speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token: code,
      window: 1,
    });
  }

  private encrypt(secret: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      iv,
    );

    const encrypted = Buffer.concat([
      cipher.update(secret, 'utf8'),
      cipher.final(),
    ]);

    const authenticationTag = cipher.getAuthTag();

    return [
      'v1',
      iv.toString('base64url'),
      authenticationTag.toString('base64url'),
      encrypted.toString('base64url'),
    ].join(':');
  }

  private decrypt(value: string): string {
    try {
      const [version, ivValue, tagValue, encryptedValue] =
        value.split(':');

      if (
        version !== 'v1' ||
        !ivValue ||
        !tagValue ||
        !encryptedValue
      ) {
        throw new Error('Invalid encrypted value');
      }

      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey,
        Buffer.from(ivValue, 'base64url'),
      );

      decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));

      return Buffer.concat([
        decipher.update(
          Buffer.from(encryptedValue, 'base64url'),
        ),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new ForbiddenException(
        'Two-factor verification is unavailable for this account',
      );
    }
  }

  private async lockAccount(
    manager: EntityManager,
    accountId: string,
  ): Promise<CustomerAccount> {
    const account = await manager
      .getRepository(CustomerAccount)
      .findOne({
        where: { id: accountId },
        lock: { mode: 'pessimistic_write' },
      });

    if (!account) {
      throw new UnauthorizedException('Customer account not found');
    }

    return account;
  }

  private assertAccountAvailable(account: CustomerAccount): void {
    if (!account.isEmailVerified) {
      throw new ForbiddenException(
        'A verified email is required',
      );
    }

    if (
      account.lockedUntil &&
      account.lockedUntil.getTime() > Date.now()
    ) {
      throw new ForbiddenException(
        'Account is temporarily locked',
      );
    }
  }

  private async rejectInvalidCode(
    outcome: VerificationOutcome,
  ): Promise<void> {
    if (outcome.valid) {
      return;
    }

    await this.accountsService.registerFailedVerification(
      outcome.accountId,
      outcome.currentAttempts,
    );

    throw new UnauthorizedException(
      'Invalid two-factor authentication code',
    );
  }
}