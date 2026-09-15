/**
 * DEPRECATED / UNUSED.
 *
 * Refresh and logout no longer take a refresh token in the request body —
 * the refresh token now lives only in the httpOnly `refresh_token` cookie
 * (see AuthController.refresh()/logout() and AuthService.getAuthCookieSettings()).
 * This file has no importers left in the codebase.
 *
 * Kept in place only because the current toolchain could not delete files
 * directly — safe to delete this file entirely.
 */
export {};
