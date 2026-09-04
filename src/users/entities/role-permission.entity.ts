import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { Role } from './role.entity';
import { Permission } from './permission.entity';

@Entity('role_permissions')
@Unique(['roleId', 'permissionId'])
export class RolePermission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'role_id', type: 'uuid' })
  roleId: string;

  @Column({ name: 'permission_id', type: 'uuid' })
  permissionId: string;

  @ManyToOne(() => Role, (role) => role.rolePermissions, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'role_id' })
  role: Role;

  @ManyToOne(
    () => Permission,
    (permission) => permission.rolePermissions,
    {
      onDelete: 'CASCADE',
    },
  )
  @JoinColumn({ name: 'permission_id' })
  permission: Permission;
}