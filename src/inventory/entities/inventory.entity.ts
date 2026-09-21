import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';

import { Product } from '../../products/entities/product.entity';
import { InventoryTransaction, InventoryTransactionType } from '../../invertoryTansaction/entity/InventoryTransaction.entity';

// Approved MVP fields only: id, productId, quantity, minimumStock,
// createdAt, updatedAt. Deliberately NOT adding status, isLowStock,
// reservedQuantity, or availableQuantity -- low stock is derived
// (quantity <= minimumStock), not stored.
@Entity('inventory')
@Check('CHK_inventory_quantity_non_negative', '"quantity" >= 0')
@Check('CHK_inventory_minimum_stock_non_negative', '"minimumStock" >= 0')
export class Inventory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Unique: Product 1 -> 1 Inventory. NOT NULL (no `nullable: true`) --
  // every Inventory row must belong to exactly one Product.
  @Index({ unique: true })
  @Column({ type: 'uuid' })
  productId: string;

  // Inventory's lifecycle is tied to its Product (see approved design) --
  // CASCADE, not RESTRICT (unlike Product -> Category), since Inventory
  // has no meaning independent of the Product it belongs to.
  @OneToOne(() => Product, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'productId' })
  product: Product;

   @OneToMany(() => InventoryTransaction, (transaction) => transaction.inventory)
    transactions: InventoryTransaction[];
  

  // No public endpoint may set this directly (see InventoryService /
  // InventoryController) -- only the atomic Product-creation flow
  // (ProductsService.create) sets the initial value (0), and future
  // InventoryTransaction-based stock-movement logic (not part of this
  // task) will be the only other writer.
  @Column({ type: 'int' })
  quantity: number;

  @Column({ type: 'int', default: 0 })
  minimumStock: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  // No `isLowStock` column -- low stock is derived as
  // `quantity <= minimumStock` wherever needed, never persisted.
}
