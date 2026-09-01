# my-app

Production-ready NestJS authentication backend.

## Stack

- **NestJS 12** — application framework
- **PostgreSQL** + **TypeORM** — persistence
- **JWT** (access + refresh tokens, rotation on refresh)
- **2FA** — TOTP via `speakeasy`, compatible with Google Authenticator
- **Email verification** — required before login
- **Password reset** — token-based, 1 hour expiry
- **Account lockout** — 5 failed attempts locks the account for 15 minutes
- **Login history** — every login attempt (success/failure) recorded with IP + user agent
- **Security** — Helmet, CORS, global rate limiting (`@nestjs/throttler`), stricter limits on `login`/`forgot-password`
- **RBAC** — `@Roles()` decorator + global `RolesGuard`

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in real values (a working `.env` with dev defaults is already included, but you must set your own JWT secrets and SMTP credentials before this is safe to use anywhere beyond your own machine).

```bash
cp .env.example .env
```

Required variables: `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN`, `MAIL_HOST`, `MAIL_PORT`, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM`, `FRONTEND_URL`, `PORT`.

The app validates these at startup and will refuse to boot if any are missing or malformed (see `src/config/env.validation.ts`).

### 3. Set up PostgreSQL

Create a database matching `DB_NAME`. In development, `synchronize: true` will auto-create tables from entities. **Do not use `synchronize` in production** — switch to TypeORM migrations before deploying.

For local SMTP testing, use Gmail SMTP: enable 2-Step Verification on the Gmail account, generate an [App Password](https://myaccount.google.com/apppasswords) (16 characters), and put it in `MAIL_PASSWORD` — never the normal Gmail password. `MAIL_USER` and the address inside `MAIL_FROM` must match the authenticated Gmail account, or Gmail will override/reject the "From" header.

### 4. Run

```bash
npm run start:dev
```

Server starts on `http://localhost:3000` (versioned routes under `/v1/...`, e.g. `/v1/auth/register`). Health check at `/v1/health`.

## API overview

All routes are protected by a global JWT guard by default; routes marked `public` bypass it.

| Method | Route | Public | Description |
|---|---|---|---|
| POST | `/auth/register` | ✅ | Create account, sends email verification link |
| GET | `/auth/verify-email?token=` | ✅ | Verify email address |
| POST | `/auth/login` | ✅ | Login; returns tokens, or `{ twoFactorRequired: true }` if 2FA is enabled |
| POST | `/auth/refresh` | ✅ | Exchange refresh token for a new token pair |
| POST | `/auth/logout` | ❌ | Revoke current refresh token |
| POST | `/auth/forgot-password` | ✅ | Request password reset email |
| POST | `/auth/reset-password` | ✅ | Reset password using emailed token |
| POST | `/auth/2fa/generate` | ❌ | Generate TOTP secret + QR code |
| POST | `/auth/2fa/enable` | ❌ | Confirm TOTP code and enable 2FA |
| POST | `/auth/2fa/disable` | ❌ | Disable 2FA (requires valid code) |
| GET | `/auth/login-history` | ❌ | List recent login attempts for the current user |
| GET | `/users/me` | ❌ | Current user profile |
| GET | `/users/admin/ping` | ❌ | Example RBAC-protected route (`ADMIN` role only) |

## Testing

```bash
npm run test        # unit tests
npm run test:e2e    # end-to-end tests
npm run test:cov    # coverage
```

## Security notes

- Passwords hashed with `bcryptjs` (12 salt rounds).
- Refresh tokens are hashed before storage and rotated on every use; reuse of a stolen/old refresh token revokes the session.
- Login and forgot-password endpoints have stricter rate limits than the rest of the API.
- Generic error messages are used on login/forgot-password to avoid leaking whether an email is registered.
- `synchronize: true` is dev-only — set up migrations before production use.
