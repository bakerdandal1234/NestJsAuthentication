import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { Strategy, StrategyOptions, Profile } from 'passport-google-oauth20';
import { OAuthProfile } from '../interfaces/oauth-profile.interface';
import { OAuthStateService } from '../oauth-state.service';
import { oauthProviderId } from '../oauth-provider-id';

/**
 * Google OAuth2 strategy. Registered in AuthModule and consumed via
 * GoogleAuthGuard (AuthGuard('google')) on GET /auth/google and
 * /auth/google/callback.
 */
@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(configService: ConfigService, oauthState: OAuthStateService) {
    super({
      clientID: configService.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      clientSecret: configService.getOrThrow<string>('GOOGLE_CLIENT_SECRET'),
      callbackURL: configService.getOrThrow<string>('GOOGLE_CALLBACK_URL'),
      scope: ['email', 'profile'],
      store: oauthState.forProvider('google'),
    } as StrategyOptions);
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
  ): Promise<OAuthProfile> {
    const primaryEmail = profile.emails?.[0];

    return {
      provider: 'google',
      providerId: oauthProviderId(profile.id),
      email: primaryEmail?.value,
      // Google reports `email_verified` per address; only a verified one may
      // be trusted to link to an existing local account.
      emailVerified: primaryEmail?.verified === true,
      firstName: profile.name?.givenName,
      lastName: profile.name?.familyName,
    };
  }
}
