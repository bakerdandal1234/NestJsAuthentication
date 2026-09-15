import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Inventory } from './entities/inventory.entity';
import { InventoryService } from './inventory.service';
import { InventoryController } from './inventory.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Inventory])],
  controllers: [InventoryController],
  providers: [InventoryService],
  // Exported so ProductsModule can inject InventoryService to atomically
  // create an Inventory row alongside a new Product (see
  // ProductsService.create()).
  exports: [InventoryService],
})
export class InventoryModule {}
