import {
  Column,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { RolePermission } from './role-permission.entity';

// A permission is identified by its (resource, action) pair — the app
// already checks for an existing pair before creating one
// (AuthorizationService.createPermission), but without this DB-level
// constraint two concurrent requests could race past that check.
@Entity('permissions')
@Unique(['resource', 'action'])
export class Permission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  action: string;

  @Column()
  resource: string;

  @Column({ nullable: true })
  description?: string;

  @OneToMany(
    () => RolePermission,
    (rolePermission) => rolePermission.permission,
  )
  rolePermissions: RolePermission[];
}