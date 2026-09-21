import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  OneToMany
} from 'typeorm';

import { Category } from '../../categories/entities/category.entity';
import { Inventory } from '../../inventory/entities/inventory.entity';
import { decimalTransformer } from '../../common/transformers/decimal.transformer';
import { OrderItem } from '../../orders/entity/order-item.entity';

export enum ProductStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

@Entity('products')
@Index('IDX_products_category_id', ['categoryId'])
export class Product {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ unique: true })
  sku: string;

  @Column({
  type: 'text',
  nullable: true,
  })
  imageUrl: string | null;

  @Column({ type: 'numeric', precision: 10, scale: 2, transformer: decimalTransformer })
  price: number;

  @Column({ type: 'numeric', precision: 10, scale: 2, transformer: decimalTransformer })
  costPrice: number;

  @Column({
    type: 'enum',
    enum: ProductStatus,
    default: ProductStatus.ACTIVE,
  })
  status: ProductStatus;

  @Column({type: 'uuid'})
  categoryId: string;

  @ManyToOne(() => Category, (category) => category.products, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'categoryId' })
  category: Category;


  @OneToMany(() => OrderItem, (item) => item.product)
orderItems: OrderItem[];

   // Inverse side; Inventory owns the productId FK.
  @OneToOne(() => Inventory, (inventory) => inventory.product)
  inventory?: Inventory;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}