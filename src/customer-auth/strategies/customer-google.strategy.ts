import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-google-oauth20';
import type { Profile } from 'passport-google-oauth20';

import type { CustomerGoogleProfile } from '../interfaces/customer-google-profile.interface';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

@Injectable()
export class CustomerGoogleStrategy extends PassportStrategy(
  Strategy,
  'customer-google',
) {
  constructor(configService: ConfigService) {
    super({
      clientID: configService.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      clientSecret: configService.getOrThrow<string>(
        'GOOGLE_CLIENT_SECRET',
      ),
      callbackURL: configService.getOrThrow<string>(
        'CUSTOMER_GOOGLE_CALLBACK_URL',
      ),
      scope: ['openid', 'email', 'profile'],
    });
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
  ): CustomerGoogleProfile {
    // This profile comes from Passport's server-side Google request,
    // not from a request body supplied by the frontend.
    const raw: unknown = profile._json;

    if (!isRecord(raw)) {
      throw new UnauthorizedException('Invalid Google profile');
    }

    // Google userinfo formats may use either field name.
    // Accept only a boolean true, not merely an existing email.
    const verified = raw.email_verified ?? raw.verified_email;

    if (verified !== true) {
      throw new UnauthorizedException(
        'A verified Google email is required',
      );
    }

    const googleId = profile.id?.trim();
    const email =
      typeof raw.email === 'string' ? raw.email.trim() : '';

    if (!googleId || !email) {
      throw new UnauthorizedException(
        'Google did not provide the required account information',
      );
    }

    return {
      googleId,
      email,
      emailVerified: true,
      firstName: profile.name?.givenName?.trim() || undefined,
      lastName: profile.name?.familyName?.trim() || undefined,
    };
  }
}