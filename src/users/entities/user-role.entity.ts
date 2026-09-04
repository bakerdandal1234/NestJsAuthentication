import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { User } from './user.entity';
import { Role } from './role.entity';

@Entity('user_roles')
@Unique(['userId', 'roleId'])
export class UserRole {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'role_id', type: 'uuid' })
  roleId: string;

  @ManyToOne(() => User, (user) => user.userRoles, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Role, (role) => role.userRoles, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'role_id' })
  role: Role;
}