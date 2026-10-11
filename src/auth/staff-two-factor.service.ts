import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import * as QRCode from 'qrcode';
import * as speakeasy from 'speakeasy';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm';

import { User } from '../users/entities/user.entity';
import { Session } from '../sessions/entities/session.entity';
import { decodeTwoFactorKey } from '../config/two-factor-key';
import {
  consumeTwoFactorStep,
  TOTP_STEP_SECONDS,
  TOTP_WINDOW_STEPS,
  TwoFactorCodeRejectedError,
} from './two-factor-step';

interface TwoFactorSetup {
  qrCodeDataUrl: string;
  secret: string;
}

interface TwoFactorSecret {
  secret: string;
  otpauthUrl: string;
}

@Injectable()
export class StaffTwoFactorService {
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {
    const configuredKey = this.config.getOrThrow<string>(
      'STAFF_2FA_ENCRYPTION_KEY',
    );

    this.encryptionKey = decodeTwoFactorKey(configuredKey);
  }

  async generateSetup(userId: string): Promise<TwoFactorSetup> {
    const generated = await this.dataSource.transaction((transaction) =>
      this.replaceSetup(transaction, userId),
    );
    return {
      secret: generated.secret,
      qrCodeDataUrl: await QRCode.toDataURL(generated.otpauthUrl),
    };
  }

  private async replaceSetup(
    transaction: EntityManager,
    userId: string,
  ): Promise<TwoFactorSecret> {
    const user = await this.lockUser(transaction, userId);
    if (user.isTwoFactorEnabled) {
      throw new ConflictException(
        'Two-factor authentication is already enabled',
      );
    }
    const generated = this.generatedSecret(user.email);
    user.twoFactorSecret = this.encrypt(generated.secret);
    user.isTwoFactorEnabled = false;
    user.twoFactorLastUsedStep = null;
    await transaction.getRepository(User).save(user);
    return generated;
  }

  private generatedSecret(email: string): TwoFactorSecret {
    const secret = speakeasy.generateSecret({
      length: 20,
      issuer: 'FlowDesk',
      name: `FlowDesk Staff (${email})`,
    });
    if (!secret.base32 || !secret.otpauth_url) {
      throw new Error('Unable to generate two-factor authentication secret');
    }
    return { secret: secret.base32, otpauthUrl: secret.otpauth_url };
  }

  async enable(userId: string, code: string): Promise<{ message: string }> {
    await this.dataSource.transaction(async (transaction) => {
      const user = await this.lockUser(transaction, userId);
      this.assertCanEnable(user);
      await this.consumeValidCode(transaction, user, code);
      await this.persistTwoFactorChange(transaction, userId, {
        isTwoFactorEnabled: true,
      });
    });

    return {
      message: 'Two-factor authentication enabled',
    };
  }

  async disable(userId: string, code: string): Promise<{ message: string }> {
    await this.dataSource.transaction(async (transaction) => {
      const user = await this.lockUser(transaction, userId);
      this.assertCanDisable(user);
      await this.consumeValidCode(transaction, user, code);
      await this.persistTwoFactorChange(transaction, userId, {
        twoFactorSecret: () => 'NULL',
        twoFactorLastUsedStep: () => 'NULL',
        isTwoFactorEnabled: false,
      });
    });

    return {
      message: 'Two-factor authentication disabled',
    };
  }

  private assertCanEnable(
    user: User,
  ): asserts user is User & { twoFactorSecret: string } {
    if (user.isTwoFactorEnabled) {
      throw new ConflictException(
        'Two-factor authentication is already enabled',
      );
    }
    if (!user.twoFactorSecret) {
      throw new BadRequestException(
        'Generate a two-factor setup before enabling it',
      );
    }
  }

  private assertCanDisable(
    user: User,
  ): asserts user is User & { twoFactorSecret: string } {
    if (!user.isTwoFactorEnabled || !user.twoFactorSecret) {
      throw new BadRequestException('Two-factor authentication is not enabled');
    }
  }

  private async consumeValidCode(
    transaction: EntityManager,
    user: User,
    code: string,
  ): Promise<void> {
    const step = this.verifiedCodeStep(user, code);
    if (step === undefined) {
      throw new BadRequestException('Invalid two-factor authentication code');
    }
    try {
      await consumeTwoFactorStep(transaction, user, step);
    } catch (error) {
      if (!(error instanceof TwoFactorCodeRejectedError)) throw error;
      throw new BadRequestException(error.message);
    }
  }

  private async persistTwoFactorChange(
    transaction: EntityManager,
    userId: string,
    change: Pick<
      QueryDeepPartialEntity<User>,
      'isTwoFactorEnabled' | 'twoFactorSecret' | 'twoFactorLastUsedStep'
    >,
  ): Promise<void> {
    await transaction
      .getRepository(User)
      .update(
        { id: userId },
        { ...change, failedLoginAttempts: 0, lockedUntil: () => 'NULL' },
      );
    // Existing sessions cannot outlive a change to the account's authentication factors.
    await transaction
      .getRepository(Session)
      .update({ userId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  verifiedCodeStep(user: User, code: string): number | undefined {
    if (!/^\d{6}$/.test(code)) return undefined;
    const time = Math.floor(Date.now() / 1000);
    const matched = speakeasy.totp.verifyDelta({
      secret: this.decrypt(user.twoFactorSecret!),
      encoding: 'base32',
      token: code,
      window: TOTP_WINDOW_STEPS,
      step: TOTP_STEP_SECONDS,
      time,
    });
    if (!matched) return undefined;
    const step = Math.floor(time / TOTP_STEP_SECONDS) + matched.delta;
    return user.twoFactorLastUsedStep == null ||
      step > user.twoFactorLastUsedStep
      ? step
      : undefined;
  }

  private encrypt(secret: string): string {
    const iv = randomBytes(12);

    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);

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
      const [version, ivValue, tagValue, encryptedValue] = value.split(':');

      if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) {
        throw new Error('Invalid encrypted value');
      }

      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey,
        Buffer.from(ivValue, 'base64url'),
      );

      decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));

      return Buffer.concat([
        decipher.update(Buffer.from(encryptedValue, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new ForbiddenException(
        'Two-factor verification is unavailable for this account',
      );
    }
  }

  private async lockUser(
    manager: EntityManager,
    userId: string,
  ): Promise<User> {
    const user = await manager.getRepository(User).findOne({
      where: { id: userId },
      lock: {
        mode: 'pessimistic_write',
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }
}
