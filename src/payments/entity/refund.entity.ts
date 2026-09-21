import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Payment } from './payment.entity';

export enum RefundStatus {
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}

@Entity('refunds')
@Index('IDX_refunds_payment_id', ['paymentId'])
@Index('IDX_refunds_idempotency_key', ['idempotencyKey'], {
  unique: true,
})
export class Refund {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  paymentId: string;

  @ManyToOne(() => Payment, (payment) => payment.refunds, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'paymentId' })
  payment: Payment;

  @Column({
    type: 'numeric',
    precision: 10,
    scale: 2,
  })
  amount: string;

  @Column({
    type: 'enum',
    enum: RefundStatus,
    default: RefundStatus.PENDING,
  })
  status: RefundStatus;

  @Column({
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  providerRefundId: string | null;

  @Column({
    type: 'varchar',
    length: 255,
    nullable: false,
  })
  idempotencyKey: string;

  @Column({
    type: 'varchar',
    length: 500,
    nullable: true,
  })
  reason: string | null;

  @CreateDateColumn({
    type: 'timestamptz',
  })
  createdAt: Date;

  @Column({
    type: 'timestamptz',
    nullable: true,
  })
  completedAt: Date | null;
}