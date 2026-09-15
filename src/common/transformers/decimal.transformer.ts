import { ValueTransformer } from 'typeorm';

/**
 * TypeORM's `numeric`/`decimal` columns return STRINGS by default (to
 * avoid floating-point precision loss at the driver level) — without
 * this, Product.price/costPrice would come back as "5.00" (a string),
 * breaking any arithmetic on them later (order totals, etc). This
 * transformer converts to a real JS number on the way out, while the DB
 * column itself stays an exact `numeric` type.
 *
 * Reusable: apply the same transformer to any future money column
 * (Order.subtotal/totalAmount, OrderItem.unitPrice, ...).
 */
export const decimalTransformer: ValueTransformer = {
  to: (value?: number) => value,
  from: (value?: string) => (value === null || value === undefined ? value : parseFloat(value)),
};
