import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { Strategy, StrategyOptions, Profile } from 'passport-github2';
import { OAuthProfile } from '../interfaces/oauth-profile.interface';
import { OAuthStateService } from '../oauth-state.service';
import { oauthProviderId } from '../oauth-provider-id';

interface GithubProfile extends Profile {
  _json: { id: unknown };
}

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
 */
@Injectable()
export class GithubStrategy extends PassportStrategy(Strategy, 'github') {
  constructor(configService: ConfigService, oauthState: OAuthStateService) {
    super({
      clientID: configService.getOrThrow<string>('GITHUB_CLIENT_ID'),
      clientSecret: configService.getOrThrow<string>('GITHUB_CLIENT_SECRET'),
      callbackURL: configService.getOrThrow<string>('GITHUB_CALLBACK_URL'),
      scope: ['user:email'],
      allRawEmails: true,
      store: oauthState.forProvider('github'),
    } as StrategyOptions);
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: GithubProfile,
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
      // Passport stringifies missing IDs, so validate the original provider value.
      providerId: this.providerId(profile._json.id),
      email: primaryEmail?.value,
      emailVerified: primaryEmail?.verified === true,
      firstName: firstName || undefined,
      lastName: rest.length ? rest.join(' ') : undefined,
    };
  }

  private providerId(identifier: unknown): string {
    if (
      typeof identifier === 'number' &&
      Number.isSafeInteger(identifier) &&
      identifier > 0
    ) {
      return String(identifier);
    }
    return oauthProviderId(identifier);
  }
}
