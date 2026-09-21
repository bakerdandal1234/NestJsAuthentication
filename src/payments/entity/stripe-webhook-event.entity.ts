import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('stripe_webhook_events')
@Index('IDX_stripe_webhook_events_stripe_event_id', ['stripeEventId'], {
  unique: true,
})
export class StripeWebhookEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'varchar',
    length: 255,
  })
  stripeEventId: string;

  @Column({
    type: 'varchar',
    length: 255,
  })
  type: string;

  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  processedAt: Date | null;

  @CreateDateColumn({
    type: 'timestamptz',
  })
  createdAt: Date;
}