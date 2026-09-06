
import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
/**
 * Route-scoped guard for GitHub's OAuth2 flow — mirrors GoogleAuthGuard.
 */


@Injectable()
export class GithubAuthGuard extends AuthGuard('github') {
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
        : new UnauthorizedException('GitHub authentication failed');
    }

    return user;
  }
}
