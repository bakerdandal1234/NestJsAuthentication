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
} from 'typeorm';

import { Category } from '../../categories/entities/category.entity';
import { Inventory } from '../../inventory/entities/inventory.entity';
import { decimalTransformer } from '../../common/transformers/decimal.transformer';

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

  @Column()
  categoryId: string;

  @ManyToOne(() => Category, (category) => category.products, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'categoryId' })
  category: Category;

  // Product 1 -> 1 Inventory (approved design). The FK itself lives on
  // Inventory.productId (see Inventory entity) -- this is just the
  // inverse side for convenient `relations: { inventory: true }` lookups
  // from the Product side. Every Product has exactly one Inventory,
  // created atomically alongside it (see ProductsService.create()).
  @OneToOne(() => Inventory, (inventory) => inventory.product)
  inventory?: Inventory;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}