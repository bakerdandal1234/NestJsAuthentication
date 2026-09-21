import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager, Not } from 'typeorm';
import Stripe from 'stripe';
import { StripeWebhookEvent } from './entity/stripe-webhook-event.entity';
import { Payment, PaymentProvider, PaymentStatus } from './entity/payment.entity';
import { Order, OrderStatus } from '../orders/entity/Order.entity';

@Injectable()
export class StripeWebhookService {
  private readonly stripe: Stripe;

  constructor(
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {
    this.stripe = new Stripe(configService.getOrThrow<string>('STRIPE_SECRET_KEY'));
  }

  async handleWebhook(req: Request) {
    const signature = req.headers['stripe-signature'];
    if (typeof signature !== 'string') {
      throw new BadRequestException('Missing Stripe signature');
    }
    if (!req.rawBody) {
      throw new BadRequestException('Missing raw body');
    }
    const secret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!secret) {
      throw new BadRequestException('Stripe webhook secret is not configured');
    }

    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(req.rawBody, signature, secret);
    } catch {
      throw new BadRequestException('Invalid Stripe signature');
    }

    // A duplicate insert waits for the first transaction; the row lock then
    // lets only one delivery apply the payment/order changes.
    return this.dataSource.transaction(async (manager) => {
      const events = manager.getRepository(StripeWebhookEvent);
      await events.createQueryBuilder().insert().values({
        stripeEventId: event.id,
        type: event.type,
        processedAt: null,
      }).orIgnore().execute();
      const stored = await events.findOneOrFail({
        where: { stripeEventId: event.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!stored.processedAt) {
        if (event.type === 'payment_intent.succeeded') {
          await this.handlePaymentIntentSucceeded(manager, event.data.object as Stripe.PaymentIntent);
        }
        await events.update(stored.id, { processedAt: new Date() });
      }
      return {
        received: true,
        eventId: event.id,
        eventType: event.type,
        webhookEventId: stored.id,
      };
    });
  }

  private async handlePaymentIntentSucceeded(manager: EntityManager, intent: Stripe.PaymentIntent): Promise<void> {
    const paymentId = intent.metadata?.flowdeskPaymentId;
    if (!paymentId || !isUUID(paymentId)) {
      throw new BadRequestException('Missing or invalid flowdeskPaymentId in Stripe metadata');
    }
    const payments = manager.getRepository(Payment);
    const orders = manager.getRepository(Order);
    const reference = await payments.findOneBy({ id: paymentId });
    if (!reference) throw new BadRequestException('Payment not found');

    // Lock the order before its payments so distinct successful payments for
    // the same order are serialized and a second charge is not fulfilled twice.
    const order = await orders.findOne({
      where: { id: reference.orderId }, lock: { mode: 'pessimistic_write' },
    });
    if (!order) throw new BadRequestException('Order not found');
    const payment = await payments.findOneOrFail({
      where: { id: paymentId }, lock: { mode: 'pessimistic_write' },
    });
    const expectedAmount = Math.round(Number(payment.amount) * 100);
    if (payment.provider !== PaymentProvider.STRIPE ||
        (payment.providerTransactionId && payment.providerTransactionId !== intent.id) ||
        intent.metadata.orderId !== order.id || intent.status !== 'succeeded' ||
        intent.currency !== 'usd' || intent.amount !== expectedAmount ||
        intent.amount_received !== expectedAmount || !Number.isSafeInteger(expectedAmount)) {
      throw new BadRequestException('Stripe payment does not match the stored payment');
    }

    // Another event id for an already successful intent must not change paidAt
    // or regress an order that has since been completed/refunded.
    if (payment.status === PaymentStatus.SUCCESS && order.status !== OrderStatus.PENDING) return;

    const otherSuccess = await payments.existsBy({
      orderId: order.id, id: Not(payment.id), status: PaymentStatus.SUCCESS,
    });
    const canConfirm = order.status === OrderStatus.PENDING && !otherSuccess &&
      Math.round(Number(order.totalAmount) * 100) === expectedAmount;
    payment.providerTransactionId = intent.id;
    payment.status = PaymentStatus.SUCCESS;
    payment.paidAt ??= new Date();
    await payments.save(payment);
    order.status = canConfirm ? OrderStatus.CONFIRMED : OrderStatus.PAYMENT_REQUIRES_REFUND;
    await orders.save(order);
  }
}
