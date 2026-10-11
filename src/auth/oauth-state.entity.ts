import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('oauth_states')
export class OAuthState {
  @PrimaryColumn({ type: 'varchar', length: 64, primaryKeyConstraintName: 'PK_oauth_states' })
  stateHash: string;

  @Column({ type: 'varchar', length: 64 })
  browserTokenHash: string;

  @Column({ type: 'varchar', length: 10 })
  provider: 'google' | 'github';

  @Index('IDX_oauth_states_expiry')
  @Column({ type: 'timestamptz' })
  expiresAt: Date;
}
