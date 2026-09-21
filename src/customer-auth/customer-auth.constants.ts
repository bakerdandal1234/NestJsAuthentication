/**
 * Single source of truth for every customer-auth cookie name, cookie path,
 * lifetime and opaque-token format.
 *
 * Why one file: the OAuth binding cookie only works if the value written by
 * the Google callback and the value read by the exchange endpoint agree on
 * name AND path AND sameSite/secure/domain. Previously those were spelled
 * out separately in the controller and in the Google guard, which is exactly
 * how a binding cookie silently stops travelling.
 */

/**
 * Path prefix every customer auth route lives under.
 *
 * IMPORTANT: this must stay in sync with main.ts's URI versioning
 * (`enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })`)
 * plus @Controller('customer/auth'). If the version prefix or the controller
 * path ever changes, the cookies below stop being sent and every exchange
 * fails with a missing binding.
 */
export const CUSTOMER_AUTH_PATH = '/v1/customer/auth';

/** Google start/callback routes — the only place the state cookie is needed. */
export const CUSTOMER_GOOGLE_PATH = `${CUSTOMER_AUTH_PATH}/google`;

export const CUSTOMER_COOKIE = {
  /** CSRF-style state for the Google authorize request. */
  state: 'customer_google_state',
  /** Binds the one-time exchange code to the browser that started the login. */
  binding: 'customer_oauth_binding',
  /** Proves an in-progress 2FA challenge without issuing a session yet. */
  twoFactor: 'customer_2fa_challenge',
  /** The customer refresh token. Deliberately NOT named like the staff one. */
  refresh: 'customer_refresh_token',
  /** JS-readable, echoed back as X-CSRF-Token on refresh. */
  csrf: 'customer_csrf_token',
} as const;

export type CustomerCookieName = keyof typeof CUSTOMER_COOKIE;

/**
 * Per-cookie Path attribute.
 *
 * The binding / 2FA / refresh cookies are scoped to the whole customer auth
 * prefix rather than to one exact endpoint: scoping a cookie to a single
 * versioned route means any change to the route, the controller path or the
 * global version prefix silently stops the browser from sending it. The
 * prefix is still narrow enough that these cookies never travel to
 * /v1/products, /v1/orders, etc.
 *
 * `csrf` is the only one at '/' — its entire purpose is to be readable by
 * frontend JS via document.cookie on a normal app page.
 */
export const CUSTOMER_COOKIE_PATH: Record<CustomerCookieName, string> = {
  state: CUSTOMER_GOOGLE_PATH,
  binding: CUSTOMER_AUTH_PATH,
  twoFactor: CUSTOMER_AUTH_PATH,
  refresh: CUSTOMER_AUTH_PATH,
  csrf: '/',
};

/** Cookies the browser must not be able to read from JS. */
export const CUSTOMER_HTTP_ONLY_COOKIES: readonly CustomerCookieName[] = [
  'state',
  'binding',
  'twoFactor',
  'refresh',
];

// ---------------------------------------------------------------------------
// Lifetimes
// ---------------------------------------------------------------------------

export const CUSTOMER_ACCESS_TTL_SECONDS = 15 * 60;
export const CUSTOMER_REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Google state cookie / state value lifetime. */
export const CUSTOMER_STATE_TTL_MS = 5 * 60 * 1000;

/**
 * One-time exchange code lifetime. Short on purpose: the frontend redeems it
 * on the very next page load, so anything longer is pure replay window.
 * (Was 50 minutes before this change.)
 */
export const CUSTOMER_EXCHANGE_TTL_SECONDS = 120;

/** How long the customer has to type their TOTP code after Google succeeds. */
export const CUSTOMER_2FA_CHALLENGE_TTL_SECONDS = 5 * 60;

/** Local-verification lockout (wrong 2FA codes only — never Google itself). */
export const CUSTOMER_MAX_FAILED_VERIFICATIONS = 5;
export const CUSTOMER_LOCK_DURATION_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Opaque handoff artifact formats
// ---------------------------------------------------------------------------

/** `<sessionId uuid>.<64 hex>` */
export const CUSTOMER_EXCHANGE_CODE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{64}$/;

/** `<64 hex>` */
export const CUSTOMER_BINDING_PATTERN = /^[0-9a-f]{64}$/;

/** `<64 hex>` — opaque token for customer_oauth_challenges, not a session id. */
export const CUSTOMER_CHALLENGE_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Marker stored in customer_sessions.refreshTokenHash while the OAuth code
 * is unredeemed. A row carrying this prefix can never be refreshed,
 * can never authenticate a request, and is never listed as a device.
 */
export const CUSTOMER_PENDING_EXCHANGE_PREFIX = 'oauth:';
