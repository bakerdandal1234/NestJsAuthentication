import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { isUUID } from 'class-validator';
import { Repository } from 'typeorm';

import { CustomerAccount } from '../entities/customer-account.entity';
import { CustomerSession } from '../entities/customer-session.entity';
import type { CustomerPrincipal } from '../interfaces/customer-principal.interface';

interface CustomerAccessPayload {
  sub: string;
  sid: string;
  type: 'customer_access';
  exp: number;
}

function isCustomerAccessPayload(
  value: unknown,
): value is CustomerAccessPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const payload = value as Record<string, unknown>;

  return (
    typeof payload.sub === 'string' &&
    isUUID(payload.sub) &&
    typeof payload.sid === 'string' &&
    isUUID(payload.sid) &&
    payload.type === 'customer_access' &&
    typeof payload.exp === 'number' &&
    Number.isFinite(payload.exp)
  );
}

@Injectable()
export class CustomerJwtStrategy extends PassportStrategy(
  Strategy,
  'customer-jwt',
) {
  constructor(
    configService: ConfigService,

    @InjectRepository(CustomerAccount)
    private readonly accountRepository: Repository<CustomerAccount>,

    @InjectRepository(CustomerSession)
    private readonly sessionRepository: Repository<CustomerSession>,
  ) {
    const secret = configService.getOrThrow<string>(
      'CUSTOMER_JWT_ACCESS_SECRET',
    );

    if (Buffer.byteLength(secret, 'utf8') < 32) {
      throw new Error(
        'CUSTOMER_JWT_ACCESS_SECRET must contain at least 32 bytes',
      );
    }

    const otherSecrets = [
      configService.get<string>('JWT_ACCESS_SECRET'),
      configService.get<string>('JWT_REFRESH_SECRET'),
      configService.get<string>('CUSTOMER_JWT_REFRESH_SECRET'),
    ];

    if (otherSecrets.includes(secret)) {
      throw new Error(
        'CUSTOMER_JWT_ACCESS_SECRET must be independent of other JWT secrets',
      );
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
      algorithms: ['HS256'],
      issuer: 'flowdesk',
      audience: 'flowdesk-customer',
    });
  }

  async validate(payload: unknown): Promise<CustomerPrincipal> {
    if (!isCustomerAccessPayload(payload)) {
      throw new UnauthorizedException('Invalid customer access token');
    }

    const session = await this.sessionRepository.findOne({
      where: {
        id: payload.sid,
        customerAccountId: payload.sub,
      },
      select: {
        id: true,
        customerAccountId: true,
        expiresAt: true,
        revokedAt: true,
      },
    });

    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now()
    ) {
      throw new UnauthorizedException('Customer session is invalid or expired');
    }

    const account = await this.accountRepository.findOne({
      where: { id: payload.sub },
      select: {
        id: true,
        customerId: true,
        email: true,
        isEmailVerified: true,
        isTwoFactorEnabled: true,
      },
    });

    if (!account || !account.isEmailVerified) {
      throw new UnauthorizedException('Customer account is unavailable');
    }

    return {
      accountId: account.id,
      customerId: account.customerId,
      sessionId: session.id,
      email: account.email,
      isEmailVerified: account.isEmailVerified,
      isTwoFactorEnabled: account.isTwoFactorEnabled,
    };
  }
}