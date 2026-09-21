import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Payment } from './entity/payment.entity';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { Refund } from './entity/refund.entity';
import { RefundsService } from './refunds.service';
import { RefundsController } from './refunds.controller';
import { StripeWebhookEvent } from './entity/stripe-webhook-event.entity';
import { StripeWebhookService } from './stripe-webhook.service';
import { StripeWebhookController } from './stripe-webhook.controller';
import { Order } from '../orders/entity/Order.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Payment, Refund, StripeWebhookEvent,Order])],
  controllers: [PaymentsController, RefundsController, StripeWebhookController],
  providers: [PaymentsService, RefundsService, StripeWebhookService],
  exports: [PaymentsService],
})
export class PaymentsModule {}