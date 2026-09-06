import { Controller, Get } from '@nestjs/common';
import { UsersService } from './users.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Permissions } from '../common/decorators/permissions.decorator';

/**
 * Shape JwtStrategy.validate() attaches to req.user for every authenticated
 * request — already carries the resolved roles/permissions, so GET /me/access
 * can return it directly without a second DB round-trip.
 */
interface AuthenticatedUser {
  id: string;
  email: string;
  roles: string[];
  permissions: string[];
}

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  async getProfile(@CurrentUser('id') userId: string) {
    return this.usersService.findById(userId);
  }

  /**
   * Self-service view of the current user's own roles/permissions, built
   * from the exact same role/permission structure JwtStrategy already
   * resolves on every request (see AuthorizationService.getUserAuthorization()
   * for the admin-facing equivalent scoped to an arbitrary :userId).
   */
  @Get('me/access')
  getMyAccess(@CurrentUser() user: AuthenticatedUser) {
    return {
      userId: user.id,
      roles: user.roles,
      permissions: user.permissions,
    };
  }

  // Example RBAC-protected route: only ADMIN role may access.
  @Permissions('admin:ping')
  @Get('admin/ping')
  adminPing() {
    return { message: 'You are an admin. Access granted.' };
  }
}
