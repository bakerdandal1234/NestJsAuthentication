import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';

import { InventoryTransactionsService } from './inventory-transactions.service';
import { PurchaseInventoryDto } from './dto/purchase-inventory.dto';
import { AdjustInventoryDto } from './dto/adjust-inventory.dto';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Permissions } from '../common/decorators/permissions.decorator';

@Controller('inventory-transactions')
export class InventoryTransactionsController {
  constructor(
    private readonly inventoryTransactionsService: InventoryTransactionsService,
  ) {}

  @Post('purchase')
  @Permissions('inventory:purchase')
  async purchase(
    @Body() dto: PurchaseInventoryDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.inventoryTransactionsService.purchase(dto, userId);
  }

  @Post('adjust')
  @Permissions('inventory:adjust')
  async adjust(
    @Body() dto: AdjustInventoryDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.inventoryTransactionsService.adjust(dto, userId);
  }

  @Get('inventory/:inventoryId')
  @Permissions('inventory:read')
  async findByInventory(
    @Param('inventoryId', ParseUUIDPipe) inventoryId: string,
  ) {
    return this.inventoryTransactionsService.findByInventory(inventoryId);
  }

  @Get(':id')
  @Permissions('inventory:read')
  async findById(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.inventoryTransactionsService.findById(id);
  }
}