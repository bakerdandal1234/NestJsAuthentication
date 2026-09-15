import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('customers')
export class Customer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  firstName: string;

  // Indexed alone (not composite with firstName): the only supported
  // search pattern is "look up by last name", matching actual customer
  // service usage — no query currently needs firstName+lastName together.
  @Column()
  lastName: string;

  // Nullable + unique: at most one customer per email, but any number of
  // customers may have no email at all (Postgres unique indexes treat
  // multiple NULLs as distinct — same reasoning as User.googleId/githubId).
  // Still the field CustomersService uses for duplicate prevention and
  // exact-match lookup whenever it IS provided.
  @Index({ unique: true })
  @Column({ nullable: true })
  email?: string;

  // Optional, and NOT unique/indexed — no query filters or searches by
  // phone alone; a household/business can legitimately share one number.
  @Column({ nullable: true })
  phone?: string;

  // --- Address, embedded directly on Customer (no Address entity, per
  // approved design) ---
  @Column()
  addressLine1: string;

  @Column({ nullable: true })
  addressLine2?: string;

  @Column()
  city: string;

  // Nullable: not every country/region uses a state/province.
  @Column({ nullable: true })
  state?: string;

  // Nullable: not every country uses a postal code.
  @Column({ nullable: true })
  postalCode?: string;

  @Column()
  country: string;

  // Indexed: this is the ORDER BY column for paginated listing
  // (CustomersService.findAll) \u2014 keeps that sort/scan efficient as the
  // table grows, rather than a full sort on every page request.
  @Index()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  // No `orders` relation yet \u2014 Order doesn't exist. Will be added here
  // (Category<->Product precedent) once the Order module is built.
}
