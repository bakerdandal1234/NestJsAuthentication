import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    OneToMany,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { decimalTransformer } from '../../common/transformers/decimal.transformer';
import { Refund } from './refund.entity';
import { Order } from '../../orders/entity/Order.entity';

export enum PaymentStatus {
    PENDING = 'PENDING',
    SUCCESS = 'SUCCESS',
    FAILED = 'FAILED',
}

export enum PaymentMethod {
    CARD = 'CARD',
}

export enum PaymentProvider {
    STRIPE = 'STRIPE',
}

@Entity('payments')
@Index('IDX_payments_order_id', ['orderId'])
@Index('IDX_payments_idempotency_key', ['idempotencyKey'], {
    unique: true,
})
export class Payment {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    orderId: string;

    @ManyToOne(() => Order, (order) => order.payments, {
        nullable: false,
        onDelete: 'RESTRICT',
    })
    @JoinColumn({ name: 'orderId' })
    order: Order;

    @Column({
        type: 'numeric',
        precision: 10,
        scale: 2,
        transformer: decimalTransformer
    })
    amount: string;


    @OneToMany(() => Refund, (refund) => refund.payment)
    refunds: Refund[];


    @Column({
        type: 'enum',
        enum: PaymentMethod,
    })
    method: PaymentMethod;

    @Column({
        type: 'enum',
        enum: PaymentStatus,
        default: PaymentStatus.PENDING,
    })
    status: PaymentStatus;

    @Column({
        type: 'enum',
        enum: PaymentProvider,
    })
    provider: PaymentProvider;

    @Column({
        type: 'varchar',
        length: 255,
        nullable: true,
    })
    providerTransactionId: string | null;

    @Column({
        type: 'varchar',
        length: 255,
        nullable: false,
    })
    idempotencyKey: string;

    @Column({
        type: 'timestamptz',
        nullable: true,
    })
    paidAt: Date | null;

    @CreateDateColumn({
        type: 'timestamptz',
    })
    createdAt: Date;
}