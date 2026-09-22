import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { Order } from '../../orders/entity/Order.entity';
import { Product } from '../../products/entities/product.entity';
import { decimalTransformer } from '../../common/transformers/decimal.transformer';
@Entity('order_items')
@Unique('UQ_order_items_order_product', ['orderId', 'productId'])
@Index('IDX_order_items_order_id', ['orderId'])
@Index('IDX_order_items_product_id', ['productId'])
@Check('CHK_order_items_quantity_positive', '"quantity" > 0')
@Check('CHK_order_items_unit_price_non_negative', '"unitPrice" >= 0')
@Check('CHK_order_items_subtotal_non_negative', '"subtotal" >= 0')
export class OrderItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  orderId: string;

  @ManyToOne(() => Order, (order) => order.items, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'orderId' })
  order: Order;

  @Column({ type: 'uuid' })
  productId: string;

  @ManyToOne(() => Product, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'productId' })
  product: Product;

  @Column({ type: 'integer' })
  quantity: number;

  @Column({
    type: 'numeric',
    precision: 10,
    scale: 2,
    transformer: decimalTransformer
  })
  unitPrice: string;

  @Column({
    type: 'numeric',
    precision: 10,
    scale: 2,
    transformer: decimalTransformer
  })
  subtotal: string;
}