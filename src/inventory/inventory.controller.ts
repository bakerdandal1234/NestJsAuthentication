import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { UpdateInventoryDto } from './dto/update-inventory.dto';
import { ListInventoryQueryDto } from './dto/list-inventory-query.dto';
import { Permissions } from '../common/decorators/permissions.decorator';

// No POST / DELETE routes: Inventory is created only as a side effect of
// Product creation (see ProductsService.create) and is never
// independently deleted through a public endpoint (see approved design).
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get()
  @Permissions('inventory:read')
  findAll(@Query() query: ListInventoryQueryDto) {
    return this.inventoryService.findAll(query);
  }

  @Get('product/:productId')
  @Permissions('inventory:read')
  findByProduct(@Param('productId') productId: string) {
    return this.inventoryService.findByProductId(productId);
  }

  @Get(':id')
  @Permissions('inventory:read')
  findOne(@Param('id') id: string) {
    return this.inventoryService.findById(id);
  }

  // inventory:update is ONLY for updating minimumStock -- quantity is
  // absent from UpdateInventoryDto entirely, so there's nothing else this
  // route could change even if called with extra fields (the global
  // ValidationPipe's forbidNonWhitelisted rejects unknown properties).
  @Patch(':id')
  @Permissions('inventory:update')
  updateMinimumStock(@Param('id') id: string, @Body() dto: UpdateInventoryDto) {
    return this.inventoryService.updateMinimumStock(id, dto);
  }
}
