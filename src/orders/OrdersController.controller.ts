import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';

import { OrdersService } from './OrdersService.service';
import { CreateOrderDto } from './dto/CreateOrderDto.dto';
import { Permissions } from '../common/decorators/permissions.decorator';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
  ) {}

  @Post()
  @Permissions('orders:create')
  create(@Body() dto: CreateOrderDto) {
    return this.ordersService.create(dto);
  }

  @Get()
  @Permissions('orders:read')
  findAll() {
    return this.ordersService.findAll();
  }

  @Get(':id')
  @Permissions('orders:read')
  findById(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ordersService.findById(id);
  }

  @Patch(':id/cancel')
  @Permissions('orders:cancel')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ordersService.cancel(id);
  }

  @Patch(':id/complete')
  @Permissions('orders:complete')
  complete(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ordersService.complete(id);
  }
}