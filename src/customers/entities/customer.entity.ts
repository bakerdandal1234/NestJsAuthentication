import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Order } from '../../orders/entity/Order.entity';
import { CustomerAccount } from '../../customer-auth/entities/customer-account.entity';

@Entity('customers')
export class Customer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true })
  firstName: string | null;

  @Column({ type: 'varchar', nullable: true })
  lastName: string | null;


  @Index({ unique: true })
  @Column()
  email: string;

  // Optional, and NOT unique/indexed — no query filters or searches by
  // phone alone; a household/business can legitimately share one number.
  @Column({ nullable: true })
  phone?: string;

  // --- Address, embedded directly on Customer (no Address entity, per
  // approved design) ---
  @Column({ nullable: true })
  addressLine1?: string;

  @Column({ nullable: true })
  addressLine2?: string;

  @Column({ nullable: true })
  city?: string;

  // Nullable: not every country/region uses a state/province.
  @Column({ nullable: true })
  state?: string;

  // Nullable: not every country uses a postal code.
  @Column({ nullable: true })
  postalCode?: string;

  @OneToMany(() => Order, (order) => order.customer)
  orders: Order[];

  // Zero-or-one login identity for this customer (Google-only login,
  // Task A). Inverse side only — CustomerAccount owns the FK/unique
  // constraint. See customer-account.entity.ts.
  @OneToOne(() => CustomerAccount, (account) => account.customer)
  account?: CustomerAccount;

  @Column({ nullable: true })
  country?: string;

  // Indexed: this is the ORDER BY column for paginated listing
  // (CustomersService.findAll) \u2014 keeps that sort/scan efficient as the
  // table grows, rather than a full sort on every page request.
  @Index()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;


}
