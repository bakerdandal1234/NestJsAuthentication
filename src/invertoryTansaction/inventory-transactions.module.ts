import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { InventoryTransactionsController } from './inventory-transactions.controller';
import { InventoryTransactionsService } from './inventory-transactions.service';

import { InventoryTransaction } from './entity/InventoryTransaction.entity';
import { Inventory } from '../inventory/entities/inventory.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      InventoryTransaction,
      Inventory,
    ]),
  ],
  controllers: [InventoryTransactionsController],
  providers: [InventoryTransactionsService],
  exports: [InventoryTransactionsService],
})
export class InventoryTransactionsModule {}