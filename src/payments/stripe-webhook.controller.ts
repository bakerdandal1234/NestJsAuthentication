import { Controller, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { StripeWebhookService } from './stripe-webhook.service';
import { Public } from '../common/decorators/public.decorator';
@Controller('payments/webhook')
export class StripeWebhookController {
  constructor(
    private readonly stripeWebhookService: StripeWebhookService,
  ) {}
  @Public()
  @Post()
  async handleWebhook(@Req() req: Request) {
    return this.stripeWebhookService.handleWebhook(req);
  }
}