import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Route-scoped guard for Google's OAuth2 flow (initiates the redirect on
 * GET /auth/google, then handles the provider's callback on
 * GET /auth/google/callback). Both routes are also marked @Public() so the
 * global JwtAuthGuard doesn't demand a Bearer token first.
 */




@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {
  handleRequest<TUser = any>(
    err: any,
    user: TUser,
    info: any,
    context: ExecutionContext,
    status?: any,
  ): TUser {
    if (err || !user) {
      throw err instanceof Error
        ? err
        : new UnauthorizedException('Google authentication failed');
    }

    return user;
  }
}

