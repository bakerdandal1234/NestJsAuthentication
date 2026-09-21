import { Body, Controller, Post } from '@nestjs/common';

import { Permissions } from '../common/decorators/permissions.decorator';
import { CreateRefundDto } from './dto/create-refund.dto';
import { RefundsService } from './refunds.service';

@Controller('payments/refunds')
export class RefundsController {
  constructor(private readonly refundsService: RefundsService) {}

  @Post()
  @Permissions('payments:refund')
  create(@Body() dto: CreateRefundDto) {
    return this.refundsService.create(dto);
  }
}