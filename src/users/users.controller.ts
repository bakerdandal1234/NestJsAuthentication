import { Controller, Get } from '@nestjs/common';
import { UsersService } from './users.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Permissions } from '../common/decorators/permissions.decorator';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  async getProfile(@CurrentUser('id') userId: string) {
    return this.usersService.findById(userId);
  }

  // Example RBAC-protected route: only ADMIN role may access.
  @Permissions('admin:ping')
  @Get('admin/ping')
  adminPing() {
    return { message: 'You are an admin. Access granted.' };
  }
}
