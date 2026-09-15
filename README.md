# my-app

Production-ready NestJS authentication & authorization backend — cookie-based
sessions with rotation, storage-free CSRF protection, Google/GitHub OAuth,
TOTP 2FA, and a full RBAC (roles/permissions) system.

## Stack

- **NestJS 11** — application framework
- **PostgreSQL** + **TypeORM** — persistence (fully migration-based, `synchronize` is always `false`)
- **JWT** access tokens + **httpOnly cookie** refresh tokens, rotated on every refresh
- **Storage-free CSRF** — `HMAC-SHA256(sessionId, CSRF_SECRET)`, no DB lookup, no extra table
- **OAuth** — Google & GitHub login via Passport, code-exchange flow (no tokens ever touch the URL)
- **2FA** — TOTP via `speakeasy`, compatible with Google Authenticator / Authy
- **Email verification** — required before login
- **Password reset** — token-based, 1 hour expiry, revokes all sessions on success
- **Account lockout** — 5 failed login attempts locks the account for 15 minutes
- **Login history** — every login attempt (success/failure) recorded with IP + user agent
- **Sessions** — every login/OAuth/refresh is a `Session` row the user can list and revoke individually or all at once
- **RBAC** — dynamic roles & permissions (`resource:action` strings, e.g. `roles:read`), managed entirely via API, no hardcoded enum
- **Security** — Helmet, scoped CORS (`credentials: true`), global rate limiting (`@nestjs/throttler`), stricter limits on `login` / `forgot-password`, global `ValidationPipe` (whitelist + reject unknown fields)

## Architecture / module map

```
src/
  auth/            AuthController, AuthService — register, login, refresh,
                    logout, OAuth callbacks + exchange, 2FA, password reset,
                    email verification, login history. Passport strategies
                    (jwt, google, github) live in auth/strategies/.
  users/            UsersController (GET /users/me, /users/me/access),
                    UsersService, and the RBAC entities (User, Role,
                    Permission, UserRole, RolePermission, LoginHistory).
  authorization/    AuthorizationController/Service — full CRUD for roles
                    & permissions, role<->permission and user<->role
                    assignment, admin-facing user listing.
  sessions/         SessionController/Service — list/revoke the current
                    user's own sessions. Session = one refresh-token
                    lineage (one login, or one OAuth login, or one device).
  common/           Global guards (JwtAuthGuard, PermissionsGuard,
                    CsrfGuard [unused — see note below]), @Public(),
                    @Permissions(), @CurrentUser() decorators, the global
                    HttpExceptionFilter.
  config/           env.validation.ts (class-validator, boot fails if
                    invalid/missing), typeorm.config.ts, data-source.ts
                    (for the TypeORM CLI).
  migrations/       5 migrations — full schema history, no synchronize.
  seeds/            seed-authorization.ts (default roles/permissions),
                    seed-admin.ts (bootstrap an admin user).
  mail/             Nodemailer wrapper for verification/reset emails.
```

Global guard order (`app.module.ts`): `JwtAuthGuard` → `PermissionsGuard`.
Every route requires a valid access token **unless** decorated with
`@Public()`; every route additionally requires the listed `@Permissions(...)`
if present (roles are resolved to their permissions at request time by
`JwtStrategy`, not re-fetched per-route).

> **Note on `CsrfGuard`**: `src/common/guards/csrf.guard.ts` exists but is
> **not used anywhere**. It implements an older double-submit-cookie design
> that was superseded by the storage-free HMAC approach in `AuthService`
> (`computeCsrfToken()`, checked inline inside `refreshTokens()`). Safe to
> delete if nothing adopts it; left in place for now.

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Then fill in real values. The app validates every variable listed below at
startup (`src/config/env.validation.ts`) and **refuses to boot** if any
required one is missing or malformed.

### 3. Set up PostgreSQL

Create a database matching `DB_NAME`. This project is **fully
migration-based** — `synchronize` is always `false` (see
`src/config/typeorm.config.ts`), so tables are never auto-created from
entities. Run the migrations:

```bash
npm run migration:run
```

Optionally seed the default roles/permissions and an admin user:

```bash
npm run seed:authorization
npm run seed:admin
```

For local SMTP testing, use Gmail SMTP: enable 2-Step Verification on the
Gmail account, generate an [App Password](https://myaccount.google.com/apppasswords)
(16 characters), and put it in `MAIL_PASSWORD` — never the normal Gmail
password. `MAIL_USER` and the address inside `MAIL_FROM` must match the
authenticated Gmail account, or Gmail will override/reject the "From"
header.

### 4. Run

```bash
npm run start:dev
```

Server starts on `http://localhost:3000` (versioned routes under
`/v1/...`, e.g. `/v1/auth/register`). Health check at `GET /v1/health`
(public, no auth required).

## API overview

All routes are protected by the global `JwtAuthGuard` by default; routes
marked **Public** bypass it. Routes with a **Permission** require the
caller's resolved permissions to include that string.

### Auth (`/v1/auth`)

| Method | Route | Public | Notes |
|---|---|---|---|
| POST | `/auth/register` | ✅ | Creates account (unverified), sends verification email, assigns the default `user` role |
| GET | `/auth/verify-email?token=` | ✅ | Verifies email address |
| POST | `/auth/login` | ✅ | Rate-limited (5/min). Returns `{ accessToken }` + sets cookies, or `{ twoFactorRequired: true }` if 2FA is enabled and no code was sent |
| POST | `/auth/refresh` | ✅ | Reads `refresh_token` cookie + requires `X-CSRF-Token` header; rotates both, returns new `{ accessToken }` |
| POST | `/auth/logout` | ❌ (bearer required) | Reads `refresh_token` cookie to identify the session, revokes it, clears both cookies |
| GET | `/auth/google` | ✅ | Redirects to Google's consent screen |
| GET | `/auth/google/callback` | ✅ | Sets auth cookies, mints an exchange code, redirects to `FRONTEND_URL/oauth/callback?code=...` |
| GET | `/auth/github` | ✅ | Redirects to GitHub's consent screen |
| GET | `/auth/github/callback` | ✅ | Same as Google callback |
| POST | `/auth/oauth/exchange` | ✅ | Body `{ code }` → `{ accessToken }`. Redeems the one-time code from an OAuth callback; relies on the refresh cookie already set by the callback |
| POST | `/auth/forgot-password` | ✅ | Rate-limited (3/min). Always returns the same generic message, whether or not the email exists |
| POST | `/auth/reset-password` | ✅ | Body `{ token, newPassword }`; revokes **all** existing sessions for that user on success |
| POST | `/auth/2fa/generate` | ❌ | Returns TOTP secret + QR code data URL |
| POST | `/auth/2fa/enable` | ❌ | Body `{ code }`; confirms the TOTP code and turns 2FA on |
| POST | `/auth/2fa/disable` | ❌ | Body `{ code }`; requires a valid current TOTP code |
| GET | `/auth/login-history` | ❌ | Recent login attempts (success/failure, IP, user agent) for the current user |

### Users (`/v1/users`)

| Method | Route | Public | Notes |
|---|---|---|---|
| GET | `/users/me` | ❌ | Current user's profile (sensitive fields stripped by `ClassSerializerInterceptor` + `@Exclude()` on the entity) |
| GET | `/users/me/access` | ❌ | `{ userId, roles, permissions }` for the current user — built from the same data `JwtStrategy` already resolves per request |
| GET | `/users/admin/ping` | Permission: `admin:ping` | Example RBAC-protected route |

### Sessions (`/v1/sessions`)

A "session" = one refresh-token lineage (one login, one OAuth login, or one
device). Every route here is scoped to the caller's own sessions only.

| Method | Route | Notes |
|---|---|---|
| GET | `/sessions` | Lists the current user's sessions (`id`, `userAgent`, `ipAddress`, `createdAt`, `lastUsedAt`, `expiresAt`, `revokedAt` — never the refresh token hash) |
| DELETE | `/sessions/:id` | Revokes one session; returns 404 (not 403) if it belongs to someone else |
| DELETE | `/sessions` | Revokes **all** of the current user's sessions |

### Authorization / RBAC (`/v1/authorization`)

Fully dynamic — roles and permissions are database rows, not hardcoded
enums. A permission is a `resource:action` pair (e.g. `roles:read`,
`users:assign-role`). Every route below requires the listed permission.

| Method | Route | Permission |
|---|---|---|
| GET | `/authorization/roles` | `roles:read` |
| POST | `/authorization/roles` | `roles:create` |
| GET | `/authorization/roles/:id` | `roles:read` |
| GET | `/authorization/roles/:id/users` | `roles:read` |
| PATCH | `/authorization/roles/:id` | `roles:update` |
| DELETE | `/authorization/roles/:id` | `roles:delete` |
| GET | `/authorization/permissions` | `permissions:read` |
| POST | `/authorization/permissions` | `permissions:create` |
| PATCH | `/authorization/permissions/:id` | `permissions:update` |
| DELETE | `/authorization/permissions/:id` | `permissions:delete` |
| POST | `/authorization/roles/:roleId/permissions/:permissionId` | `roles:assign-permission` |
| DELETE | `/authorization/roles/:roleId/permissions/:permissionId` | `roles:assign-permission` |
| POST | `/authorization/users/:userId/roles/:roleId` | `users:assign-role` |
| DELETE | `/authorization/users/:userId/roles/:roleId` | `users:assign-role` |
| GET | `/authorization/users/:userId/access` | `users:read` — admin-facing equivalent of `GET /users/me/access` for an arbitrary user |
| GET | `/authorization/users` | `roles:read` — full user list for an admin dashboard |

### Health

| Method | Route | Public |
|---|---|---|
| GET | `/health` | ✅ |

## Authentication flow explained

1. **Register** → `POST /auth/register`. Password is bcrypt-hashed
   (`bcryptjs`, 12 rounds). An `emailVerificationToken` is generated and
   emailed; the user is assigned the default `user` role. Login is blocked
   until the email is verified.
2. **Verify email** → `GET /auth/verify-email?token=...`.
3. **Login** → `POST /auth/login`. On success:
   - A `Session` row is created (hashed refresh token, `expiresAt`, IP,
     user agent).
   - The response body contains **only** `{ accessToken }` — the refresh
     token and CSRF token travel as cookies, never in the body.
   - If 2FA is enabled, a first call without `twoFactorCode` returns
     `{ twoFactorRequired: true }` instead; the client resubmits with the
     code.
   - 5 failed attempts in a row lock the account for 15 minutes
     (`failedLoginAttempts` / `lockedUntil` on `User`).
   - Every attempt (success or failure) is recorded in `login_history`.
4. **Refresh** → `POST /auth/refresh`, cookie + CSRF header only (see
   below). Rotates both the refresh token and CSRF token; reusing an
   already-rotated refresh token revokes the whole session (theft
   detection).
5. **Logout** → `POST /auth/logout`, bearer token + refresh cookie.
   Revokes only that one session; clears both cookies.

## Cookies & CSRF

Two cookies are set together by login, refresh, and the OAuth callbacks —
with `SameSite`/`Secure`/`Domain` driven by `COOKIE_SAME_SITE` /
`COOKIE_DOMAIN` (see `AuthService.getAuthCookieSettings()`). Their `Path`
deliberately differs between the two:

| Cookie | `httpOnly` | `Path` | Purpose |
|---|---|---|---|
| `refresh_token` | ✅ | `/v1/auth` | The actual refresh JWT. Never readable by frontend JS, so it only needs to reach auth endpoints. |
| `csrf_token` | ❌ | `/` | `HMAC-SHA256(sessionId, CSRF_SECRET)`. Readable by frontend JS so it can be echoed back. |

**Why `csrf_token` is `Path=/` and not `/v1/auth`:** cookie `Path` doesn't
just control which *requests* carry a cookie — it also controls which pages
can read it via `document.cookie` (only pages whose URL starts with that
Path can see it). `csrf_token`'s entire purpose is to be read by frontend JS
running on the SPA's own pages (`/`, `/login`, etc.), none of which start
with `/v1/auth` — so scoping it there would make it invisible to the exact
code that needs to read it. `refresh_token` has no such requirement (JS
never reads it), so it stays scoped to `/v1/auth` to minimize which
requests carry it.

**No CSRF token is ever stored in the database.** `AuthController.refresh()`
reads `refresh_token` from the cookie, verifies it, extracts the session id,
and `AuthService` independently recomputes the expected CSRF value and
compares it (constant-time) against the `X-CSRF-Token` header. A mismatch or
missing header → `403`. This protects `/auth/refresh` from CSRF because a
malicious site can trigger the cookie-bearing request but cannot read
`csrf_token` to put it in the header (Same-Origin Policy).

Frontend usage:
```js
// after login, cookies are already set by the server
const csrfToken = document.cookie.match(/csrf_token=([^;]+)/)?.[1];
await fetch('/v1/auth/refresh', {
  method: 'POST',
  credentials: 'include',
  headers: { 'X-CSRF-Token': decodeURIComponent(csrfToken) },
});
```

`logout` does **not** require the CSRF header — it's already protected by
the bearer access-token requirement instead.

## OAuth (Google / GitHub)

1. Frontend redirects the browser to `GET /v1/auth/google` (or `/github`).
2. Provider redirects back to `.../callback`. The server authenticates the
   user (creating or linking the account by verified email — see
   `AuthService`'s OAuth resolution logic), creates a `Session`, sets the
   same `refresh_token`/`csrf_token` cookies as a normal login, mints a
   short-lived (60s) single-use exchange code, and redirects the browser to
   `FRONTEND_URL/oauth/callback?code=...`.
   **Access and refresh tokens never appear in the URL.**
3. Frontend calls `POST /v1/auth/oauth/exchange` with `{ code }` to get the
   real `{ accessToken }`. The refresh cookie is already in place from step 2.

## 2FA (TOTP)

`POST /auth/2fa/generate` → `POST /auth/2fa/enable` (confirms a code from
an authenticator app) → `isTwoFactorEnabled = true`. From then on, `login`
requires a valid `twoFactorCode` alongside the password. `POST
/auth/2fa/disable` requires a currently-valid code to turn it back off.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | ✅ | affects cookie `secure`/`sameSite` defaults and SSL |
| `PORT` | ✅ | |
| `FRONTEND_URL` | ✅ | used for CORS origin and OAuth redirect target |
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME` | ✅ | |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | ✅ | |
| `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN` | ✅ | e.g. `15m`, `7d` |
| `MAIL_HOST`, `MAIL_PORT`, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM` | ✅ | |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | ✅ | |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_CALLBACK_URL` | ✅ | |
| `COOKIE_SAME_SITE` | optional | `lax` \| `strict` \| `none`; defaults to `none` in production, `lax` otherwise |
| `COOKIE_DOMAIN` | optional | only for cross-subdomain deployments |
| `CSRF_SECRET` | ✅ | HMAC key for the storage-free CSRF token |
| `OAUTH_CODE_SECRET` | ✅ | signing key for the short-lived OAuth exchange code |

## Scripts

```bash
npm run start:dev          # dev server, watch mode
npm run build               # nest build
npm run lint                 # oxlint

npm run test                # unit tests
npm run test:e2e            # end-to-end tests (needs test/jest-e2e.json + a real Postgres per .env)
npm run test:cov            # coverage

npm run migration:generate  # generate a new migration from entity changes
npm run migration:run       # apply pending migrations
npm run migration:revert    # revert the last migration

npm run seed:authorization  # seed default roles/permissions
npm run seed:admin          # bootstrap an admin user
```

## Security notes

- Passwords hashed with `bcryptjs` (12 salt rounds).
- Refresh tokens are hashed before storage and rotated on every use; reuse
  of a stolen/old refresh token revokes the whole session.
- CSRF protection on `/auth/refresh` is storage-free (HMAC of the session
  id) — see "Cookies & CSRF" above.
- Login and forgot-password endpoints have stricter rate limits than the
  rest of the API.
- Generic error messages are used on login/forgot-password to avoid
  leaking whether an email is registered.
- `GET /users/me` and `GET /authorization/users` strip sensitive fields via
  the global `ClassSerializerInterceptor` + `@Exclude()` on `User`;
  `GET /sessions` uses an explicit safe-field whitelist instead (never the
  refresh token hash).
- `synchronize` is always `false` — schema changes must go through
  `npm run migration:generate` / `migration:run`.
- Helmet, scoped CORS with `credentials: true`, and `app.set('trust
  proxy', 1)` (so `secure` cookies and `req.ip` work correctly behind a
  reverse proxy/load balancer) are configured in `main.ts`.
