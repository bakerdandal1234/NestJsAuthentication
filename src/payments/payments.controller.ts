import { Body, Controller, Post } from '@nestjs/common';

import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { Permissions } from '../common/decorators/permissions.decorator';
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  @Permissions('payments:create')
  create(@Body() dto: CreatePaymentDto) {
    return this.paymentsService.create(dto);
  }
}