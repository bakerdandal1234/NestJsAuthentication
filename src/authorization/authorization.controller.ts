import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';

import { AuthorizationService } from './authorization.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { CreatePermissionDto } from './dto/create-permission.dto';
import { UpdatePermissionDto } from './dto/update-permission.dto';

import { Permissions } from '../common/decorators/permissions.decorator';

@Controller('authorization')
export class AuthorizationController {
  constructor(
    private readonly authorizationService: AuthorizationService,
  ) {}

  // ============================================================
  // ROLES
  // ============================================================

  @Get('roles')
  @Permissions('roles:read')
  findAllRoles() {
    return this.authorizationService.findAllRoles();
  }

  @Post('roles')
  @Permissions('roles:create')
  createRole(@Body() dto: CreateRoleDto) {
    return this.authorizationService.createRole(dto);
  }

  @Get('roles/:id')
  @Permissions('roles:read')
  findRole(@Param('id') id: string) {
    return this.authorizationService.findRoleById(id);
  }

  @Patch('roles/:id')
  @Permissions('roles:update')
  updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
  ) {
    return this.authorizationService.updateRole(
      id,
      dto,
    );
  }

  @Delete('roles/:id')
  @Permissions('roles:delete')
  deleteRole(@Param('id') id: string) {
    return this.authorizationService.deleteRole(id);
  }

  // ============================================================
  // PERMISSIONS
  // ============================================================

  @Get('permissions')
  @Permissions('permissions:read')
  findAllPermissions() {
    return this.authorizationService.findAllPermissions();
  }

  @Post('permissions')
  @Permissions('permissions:create')
  createPermission(
    @Body() dto: CreatePermissionDto,
  ) {
    return this.authorizationService.createPermission(
      dto,
    );
  }

  @Patch('permissions/:id')
  @Permissions('permissions:update')
  updatePermission(
    @Param('id') id: string,
    @Body() dto: UpdatePermissionDto,
  ) {
    return this.authorizationService.updatePermission(
      id,
      dto,
    );
  }

  @Delete('permissions/:id')
  @Permissions('permissions:delete')
  deletePermission(
    @Param('id') id: string,
  ) {
    return this.authorizationService.deletePermission(
      id,
    );
  }

  // ============================================================
  // ROLE ↔ PERMISSION
  // ============================================================

  @Post(
    'roles/:roleId/permissions/:permissionId',
  )
  @Permissions('roles:assign-permission')
  assignPermissionToRole(
    @Param('roleId') roleId: string,
    @Param('permissionId') permissionId: string,
  ) {
    return this.authorizationService.assignPermissionToRole(
      roleId,
      permissionId,
    );
  }

  @Delete(
    'roles/:roleId/permissions/:permissionId',
  )
  @Permissions('roles:assign-permission')
  removePermissionFromRole(
    @Param('roleId') roleId: string,
    @Param('permissionId') permissionId: string,
  ) {
    return this.authorizationService.removePermissionFromRole(
      roleId,
      permissionId,
    );
  }

  // ============================================================
  // USER ↔ ROLE
  // ============================================================

  @Post(
    'users/:userId/roles/:roleId',
  )
  @Permissions('users:assign-role')
  assignRoleToUser(
    @Param('userId') userId: string,
    @Param('roleId') roleId: string,
  ) {
    return this.authorizationService.assignRoleToUser(
      userId,
      roleId,
    );
  }

  @Delete(
    'users/:userId/roles/:roleId',
  )
  @Permissions('users:assign-role')
  removeRoleFromUser(
    @Param('userId') userId: string,
    @Param('roleId') roleId: string,
  ) {
    return this.authorizationService.removeRoleFromUser(
      userId,
      roleId,
    );
  }

  @Get(
    'users/:userId/access',
  )
  @Permissions('users:read')
  getUserAuthorization(
    @Param('userId') userId: string,
  ) {
    return this.authorizationService.getUserAuthorization(
      userId,
    );
  }
}