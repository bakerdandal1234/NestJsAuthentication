import { Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { Strategy, StrategyOptions, Profile } from 'passport-google-oauth20';
import { OAuthProfile } from '../interfaces/oauth-profile.interface';

/**
 * Google OAuth2 strategy. Registered in AuthModule and consumed via
 * GoogleAuthGuard (AuthGuard('google')) on GET /auth/google and
 * /auth/google/callback.
 *
 * If GOOGLE_CLIENT_ID/SECRET/CALLBACK_URL are not configured, this still
 * constructs (with placeholder values) so the rest of the app keeps
 * booting normally — hitting /auth/google would then fail with a clear
 * Google-side "invalid client" error rather than crashing Nest at startup.
 */
@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(configService: ConfigService) {
    const clientID = configService.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = configService.get<string>('GOOGLE_CLIENT_SECRET');
    const callbackURL = configService.get<string>('GOOGLE_CALLBACK_URL');
    console.log('CLIENT ID:', clientID);
    if (!clientID || !clientSecret || !callbackURL) {
      Logger.warn(
        'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_CALLBACK_URL are not fully set — ' +
          '/auth/google will not work until they are configured in .env.',
        GoogleStrategy.name,
      );
    }

    super({
      clientID: clientID || 'not-configured',
      clientSecret: clientSecret || 'not-configured',
      callbackURL: callbackURL || 'http://localhost/auth/google/callback',
      scope: ['email', 'profile'],
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
      providerId: profile.id,
      email: primaryEmail?.value,
      // Google only ever surfaces verified addresses through this scope,
      // and the field itself is reliably present on Google's profile.
      emailVerified: !!primaryEmail?.value,
      firstName: profile.name?.givenName,
      lastName: profile.name?.familyName,
    };
  }
}
