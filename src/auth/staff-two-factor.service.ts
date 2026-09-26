import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import * as QRCode from 'qrcode';
import * as speakeasy from 'speakeasy';
import { DataSource, EntityManager } from 'typeorm';

import { User } from '../users/entities/user.entity';

interface TwoFactorSetup {
  qrCodeDataUrl: string;
  secret: string;
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

    const decodedKey = Buffer.from(configuredKey, 'base64');

    if (decodedKey.length !== 32) {
      throw new Error(
        'STAFF_2FA_ENCRYPTION_KEY must be exactly 32 bytes encoded as Base64',
      );
    }

    this.encryptionKey = decodedKey;
  }

  async generateSetup(userId: string): Promise<TwoFactorSetup> {
    const generated = await this.dataSource.transaction(
      async (manager) => {
        const user = await this.lockUser(manager, userId);

        if (user.isTwoFactorEnabled) {
          throw new ConflictException(
            'Two-factor authentication is already enabled',
          );
        }

        const secret = speakeasy.generateSecret({
          length: 20,
          issuer: 'FlowDesk',
          name: `FlowDesk Staff (${user.email})`,
        });

        if (!secret.base32 || !secret.otpauth_url) {
          throw new Error(
            'Unable to generate two-factor authentication secret',
          );
        }

        user.twoFactorSecret = this.encrypt(secret.base32);
        user.isTwoFactorEnabled = false;

        await manager.getRepository(User).save(user);

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
    userId: string,
    code: string,
  ): Promise<{ message: string }> {
    await this.dataSource.transaction(async (manager) => {
      const user = await this.lockUser(manager, userId);

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

      if (!this.verifyStoredCode(user.twoFactorSecret, code)) {
        throw new BadRequestException(
          'Invalid two-factor authentication code',
        );
      }

      await manager
        .createQueryBuilder()
        .update(User)
        .set({
          isTwoFactorEnabled: true,
          failedLoginAttempts: 0,
          lockedUntil: () => 'NULL',
        })
        .where('id = :userId', { userId })
        .execute();
    });

    return {
      message: 'Two-factor authentication enabled',
    };
  }

  async disable(
    userId: string,
    code: string,
  ): Promise<{ message: string }> {
    await this.dataSource.transaction(async (manager) => {
      const user = await this.lockUser(manager, userId);

      if (
        !user.isTwoFactorEnabled ||
        !user.twoFactorSecret
      ) {
        throw new BadRequestException(
          'Two-factor authentication is not enabled',
        );
      }

      if (!this.verifyStoredCode(user.twoFactorSecret, code)) {
        throw new BadRequestException(
          'Invalid two-factor authentication code',
        );
      }

      await manager
        .createQueryBuilder()
        .update(User)
        .set({
          twoFactorSecret: () => 'NULL',
          isTwoFactorEnabled: false,
          failedLoginAttempts: 0,
          lockedUntil: () => 'NULL',
        })
        .where('id = :userId', { userId })
        .execute();
    });

    return {
      message: 'Two-factor authentication disabled',
    };
  }

  verifyStoredCode(
    encryptedSecret: string,
    code: string,
  ): boolean {
    if (!/^\d{6}$/.test(code)) {
      return false;
    }

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
      const [
        version,
        ivValue,
        tagValue,
        encryptedValue,
      ] = value.split(':');

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

      decipher.setAuthTag(
        Buffer.from(tagValue, 'base64url'),
      );

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

  private async lockUser(
    manager: EntityManager,
    userId: string,
  ): Promise<User> {
    const user = await manager
      .getRepository(User)
      .findOne({
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