import { Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { Strategy, StrategyOptions, Profile } from 'passport-github2';
import { OAuthProfile } from '../interfaces/oauth-profile.interface';

/**
 * GitHub OAuth2 strategy. Registered in AuthModule and consumed via
 * GithubAuthGuard (AuthGuard('github')) on GET /auth/github and
 * /auth/github/callback.
 *
 * Same "boot with placeholders if unconfigured" behavior as GoogleStrategy
 * — see the comment there for why.
 */
@Injectable()
export class GithubStrategy extends PassportStrategy(Strategy, 'github') {
  constructor(configService: ConfigService) {
    const clientID = configService.get<string>('GITHUB_CLIENT_ID');
    const clientSecret = configService.get<string>('GITHUB_CLIENT_SECRET');
    const callbackURL = configService.get<string>('GITHUB_CALLBACK_URL');
    console.log('CLIENT ID:', clientID);
    if (!clientID || !clientSecret || !callbackURL) {
      Logger.warn(
        'GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / GITHUB_CALLBACK_URL are not fully set — ' +
          '/auth/github will not work until they are configured in .env.',
        GithubStrategy.name,
      );
    }

    super({
      clientID: clientID || 'not-configured',
      clientSecret: clientSecret || 'not-configured',
      callbackURL: callbackURL || 'http://localhost/auth/github/callback',
      scope: ['user:email'],
    } as StrategyOptions);
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
  ): Promise<OAuthProfile> {
    // With the `user:email` scope, passport-github2 populates `emails` from
    // GitHub's /user/emails endpoint, which only ever lists addresses tied
    // to the account (GitHub itself requires them to be usable there) —
    // there is no separate "verified" flag exposed on this mapped profile,
    // so presence here is treated as sufficiently trustworthy for linking.
    // A user with every email set to private will have an empty array;
    // AuthService handles that as a "missing email" OAuth error.
    const primaryEmail = profile.emails?.[0]?.value;
    const [firstName, ...rest] = (profile.displayName ?? '').split(' ');

    return {
      provider: 'github',
      providerId: profile.id,
      email: primaryEmail,
      emailVerified: !!primaryEmail,
      firstName: firstName || undefined,
      lastName: rest.length ? rest.join(' ') : undefined,
    };
  }
}
