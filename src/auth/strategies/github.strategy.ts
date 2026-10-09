import { Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { Strategy, StrategyOptions, Profile } from 'passport-github2';
import { OAuthProfile } from '../interfaces/oauth-profile.interface';

/** Raw email entry from GitHub's /user/emails, present when `allRawEmails` is enabled. */
interface GithubEmail {
  value: string;
  primary: boolean;
  verified: boolean;
}

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
      allRawEmails: true,
    } as StrategyOptions);
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
  ): Promise<OAuthProfile> {
    // `allRawEmails: true` (see the constructor) keeps GitHub's `primary` and
    // `verified` flags, which passport-github2 otherwise drops. Only a
    // verified address may be trusted to link to an existing local account
    // (see AuthService.resolveOAuthUser()). A user with no primary address
    // gets no email here, which AuthService reports as a "missing email" error.
    const primaryEmail = (profile.emails as GithubEmail[] | undefined)?.find(
      (email) => email.primary,
    );
    const [firstName, ...rest] = (profile.displayName ?? '').split(' ');

    return {
      provider: 'github',
      providerId: profile.id,
      email: primaryEmail?.value,
      emailVerified: primaryEmail?.verified === true,
      firstName: firstName || undefined,
      lastName: rest.length ? rest.join(' ') : undefined,
    };
  }
}
