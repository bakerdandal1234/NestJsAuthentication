/**
 * Normalized shape both OAuth strategies (Google, GitHub) return from their
 * validate() method — AuthService.loginWithOAuth() only ever deals with
 * this shape, never with the raw provider-specific profile object.
 */
export interface OAuthProfile {
  provider: 'google' | 'github';
  providerId: string;
  email?: string;
  /**
   * Whether the provider itself vouches for this email address. Only a
   * verified email is trusted to auto-link to an existing local account —
   * see AuthService.resolveOAuthUser() for why this matters.
   */
  emailVerified: boolean;
  firstName?: string;
  lastName?: string;
}
