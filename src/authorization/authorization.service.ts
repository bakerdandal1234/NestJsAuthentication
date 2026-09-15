import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { User } from '../users/entities/user.entity';
import { Role } from '../users/entities/role.entity';
import { Permission } from '../users/entities/permission.entity';
import { UserRole } from '../users/entities/user-role.entity';
import { RolePermission } from '../users/entities/role-permission.entity';

import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { CreatePermissionDto } from './dto/create-permission.dto';
import { UpdatePermissionDto } from './dto/update-permission.dto';

@Injectable()
export class AuthorizationService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,

    @InjectRepository(Role)
    private readonly roleRepository: Repository<Role>,

    @InjectRepository(Permission)
    private readonly permissionRepository: Repository<Permission>,

    @InjectRepository(UserRole)
    private readonly userRoleRepository: Repository<UserRole>,

    @InjectRepository(RolePermission)
    private readonly rolePermissionRepository: Repository<RolePermission>,
  ) {}

  // ============================================================
  // ROLES
  // ============================================================

  async createRole(dto: CreateRoleDto): Promise<Role> {
    const existing = await this.roleRepository.findOne({
      where: { name: dto.name },
    });

    if (existing) {
      throw new ConflictException('Role already exists');
    }

    const role = this.roleRepository.create(dto);

    return this.roleRepository.save(role);
  }

  async findAllRoles(): Promise<Role[]> {
    return this.roleRepository.find({
      relations: {
        rolePermissions: {
          permission: true,
        },
      },
      order: {
        name: 'ASC',
      },
    });
  }

  async findRoleById(id: string): Promise<Role> {
    const role = await this.roleRepository.findOne({
      where: { id },
      relations: {
        rolePermissions: {
          permission: true,
        },
      },
    });

    if (!role) {
      throw new NotFoundException('Role not found');
    }

    return role;
  }

  async findUsersByRole(roleId: string): Promise<{ id: string; email: string }[]> {
    await this.findRoleById(roleId); // throws NotFoundException if the role doesn't exist

    const userRoles = await this.userRoleRepository.find({
      where: { roleId },
      relations: { user: true },
    });

    return userRoles.map((userRole) => ({
      id: userRole.user.id,
      email: userRole.user.email,
    }));
  }

  async updateRole(
    id: string,
    dto: UpdateRoleDto,
  ): Promise<Role> {
    const role = await this.findRoleById(id);

    if (dto.name && dto.name !== role.name) {
      const existing = await this.roleRepository.findOne({
        where: { name: dto.name },
      });

      if (existing) {
        throw new ConflictException('Role already exists');
      }
    }

    Object.assign(role, dto);

    return this.roleRepository.save(role);
  }

  async deleteRole(id: string): Promise<void> {
    const role = await this.findRoleById(id);

    await this.roleRepository.remove(role);
  }

  // ============================================================
  // PERMISSIONS
  // ============================================================

  async createPermission(
    dto: CreatePermissionDto,
  ): Promise<Permission> {
    const existing = await this.permissionRepository.findOne({
      where: {
        action: dto.action,
        resource: dto.resource,
      },
    });

    if (existing) {
      throw new ConflictException(
        'Permission already exists',
      );
    }

    const permission =
      this.permissionRepository.create(dto);

    return this.permissionRepository.save(permission);
  }

  async findAllPermissions(): Promise<Permission[]> {
    return this.permissionRepository.find({
      order: {
        resource: 'ASC',
        action: 'ASC',
      },
    });
  }

  async findPermissionById(id: string): Promise<Permission> {
    const permission =
      await this.permissionRepository.findOne({
        where: { id },
      });

    if (!permission) {
      throw new NotFoundException('Permission not found');
    }

    return permission;
  }

  async updatePermission(
    id: string,
    dto: UpdatePermissionDto,
  ): Promise<Permission> {
    const permission =
      await this.findPermissionById(id);

    const action = dto.action ?? permission.action;
    const resource = dto.resource ?? permission.resource;

    const existing =
      await this.permissionRepository.findOne({
        where: {
          action,
          resource,
        },
      });

    if (existing && existing.id !== id) {
      throw new ConflictException(
        'Permission already exists',
      );
    }

    Object.assign(permission, dto);

    return this.permissionRepository.save(permission);
  }

  async deletePermission(id: string): Promise<void> {
    const permission =
      await this.findPermissionById(id);

    await this.permissionRepository.remove(permission);
  }

  // ============================================================
  // ROLE ↔ PERMISSION
  // ============================================================

  async assignPermissionToRole(
    roleId: string,
    permissionId: string,
  ): Promise<RolePermission> {
    await this.findRoleById(roleId);
    await this.findPermissionById(permissionId);

    const existing =
      await this.rolePermissionRepository.findOne({
        where: {
          roleId,
          permissionId,
        },
      });

    if (existing) {
      return existing;
    }

    const rolePermission =
      this.rolePermissionRepository.create({
        roleId,
        permissionId,
      });

    return this.rolePermissionRepository.save(
      rolePermission,
    );
  }

  async removePermissionFromRole(
    roleId: string,
    permissionId: string,
  ): Promise<void> {
    const relation =
      await this.rolePermissionRepository.findOne({
        where: {
          roleId,
          permissionId,
        },
      });

    if (!relation) {
      throw new NotFoundException(
        'Role permission assignment not found',
      );
    }

    await this.rolePermissionRepository.remove(relation);
  }

  // ============================================================
  // USER ↔ ROLE
  // ============================================================

  async assignRoleToUser(
    userId: string,
    roleId: string,
  ): Promise<UserRole> {
    await this.findUserById(userId);
    await this.findRoleById(roleId);

    const existing =
      await this.userRoleRepository.findOne({
        where: {
          userId,
          roleId,
        },
      });

    if (existing) {
      return existing;
    }

    const userRole =
      this.userRoleRepository.create({
        userId,
        roleId,
      });

    return this.userRoleRepository.save(userRole);
  }

  async assignRoleByName(
    userId: string,
    roleName: string,
  ): Promise<UserRole> {
    const role = await this.roleRepository.findOne({
      where: {
        name: roleName,
      },
    });

    if (!role) {
      throw new NotFoundException(
        `Role "${roleName}" not found`,
      );
    }

    return this.assignRoleToUser(
      userId,
      role.id,
    );
  }

  async removeRoleFromUser(
    userId: string,
    roleId: string,
  ): Promise<void> {
    const relation =
      await this.userRoleRepository.findOne({
        where: {
          userId,
          roleId,
        },
      });

    if (!relation) {
      throw new NotFoundException(
        'User role assignment not found',
      );
    }

    await this.userRoleRepository.remove(relation);
  }

  async getUserAuthorization(userId: string) {
    const user =
      await this.userRepository.findOne({
        where: { id: userId },
        relations: {
          userRoles: {
            role: {
              rolePermissions: {
                permission: true,
              },
            },
          },
        },
      });

    if (!user) {
      throw new NotFoundException(
        'User not found',
      );
    }

    const roles = user.userRoles.map(
      (item) => item.role.name,
    );

    const permissions =
      user.userRoles.flatMap(
        (item) =>
          item.role.rolePermissions.map(
            (item) =>
              `${item.permission.resource}:${item.permission.action}`,
          ),
      );

    return {
      userId: user.id,
      roles: [...new Set(roles)],
      permissions: [...new Set(permissions)],
    };
  }

  // ============================================================
  // USERS
  // ============================================================

  async findUserById(id: string): Promise<User> {
    const user =
      await this.userRepository.findOne({
        where: { id },
      });

    if (!user) {
      throw new NotFoundException(
        'User not found',
      );
    }

    return user;
  }

  async findAllUsers(): Promise<User[]> {
    return this.userRepository.find({
      order: {
        email: 'ASC',
      },
    });
  }
}