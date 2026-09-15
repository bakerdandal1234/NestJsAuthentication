/**
 * Minimal ambient augmentation for `req.cookies`, normally supplied by
 * `@types/cookie-parser`. This project parses cookies itself with the
 * `cookie` package (see main.ts) rather than adding that dependency, so the
 * shape is declared here instead.
 */
import 'express';

declare module 'express-serve-static-core' {
  interface Request {
    cookies: Record<string, string | undefined>;
  }
}
