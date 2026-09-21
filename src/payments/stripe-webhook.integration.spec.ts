import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource, In } from 'typeorm';
import Stripe from 'stripe';
import type { Request } from 'express';
import { AppDataSource } from '../config/data-source';
import { Customer } from '../customers/entities/customer.entity';
import { Order, OrderStatus } from '../orders/entity/Order.entity';
import { Payment, PaymentMethod, PaymentProvider, PaymentStatus } from './entity/payment.entity';
import { StripeWebhookEvent } from './entity/stripe-webhook-event.entity';
import { StripeWebhookService } from './stripe-webhook.service';
import { OrdersService } from '../orders/OrdersService.service';
import { RefundsService } from './refunds.service';

// Explicit opt-in: uses isolated test records in the configured local database,
// deletes only those records, and never calls Stripe or applies migrations.
const describeDatabase = process.env.RUN_PAYMENT_DB_TESTS === '1' ? describe : describe.skip;

describeDatabase('Stripe order confirmation (PostgreSQL)', () => {
  let db: DataSource;
  let service: StripeWebhookService;
  let customerId: string;
  let order: Order;
  let eventIds: string[];
  const config = new ConfigService({ STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_integration' });
  const stripe = new Stripe('sk_test_fake');

  beforeAll(async () => {
    db = new DataSource({ ...AppDataSource.options, logging: false, synchronize: false, migrationsRun: false });
    await db.initialize();
    service = new StripeWebhookService(config, db, new RefundsService(db, config));
  }, 30000);

  beforeEach(async () => {
    customerId = randomUUID();
    eventIds = [];
    await db.getRepository(Customer).save({ id: customerId, email: `payment-test-${customerId}@example.invalid`, firstName: 'Test', lastName: 'Only' });
    order = await db.getRepository(Order).save({ customerId, status: OrderStatus.PENDING, subtotal: '100.00', totalAmount: '100.00' });
  });

  afterEach(async () => {
    await db.transaction(async (manager) => {
      if (eventIds.length) await manager.delete(StripeWebhookEvent, { stripeEventId: In(eventIds) });
      if (order?.id) {
        await manager.delete(Payment, { orderId: order.id });
        await manager.delete(Order, { id: order.id });
      }
      if (customerId) await manager.delete(Customer, { id: customerId });
    });
  });
  afterAll(async () => { if (db?.isInitialized) await db.destroy(); });

  async function payment() {
    return db.getRepository(Payment).save({ orderId: order.id, amount: '100.00', method: PaymentMethod.CARD,
      provider: PaymentProvider.STRIPE, status: PaymentStatus.PENDING,
      providerTransactionId: `pi_test_${randomUUID()}`, idempotencyKey: randomUUID() });
  }

  function request(p: Payment, id = `evt_local_${randomUUID()}`): Request {
    eventIds.push(id);
    const body = JSON.stringify({ id, type: 'payment_intent.succeeded', data: { object: {
      id: p.providerTransactionId, metadata: { flowdeskPaymentId: p.id, orderId: order.id },
      currency: 'usd', amount: 10000, amount_received: 10000, status: 'succeeded',
    } } });
    return { rawBody: Buffer.from(body), headers: { 'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload: body, secret: 'whsec_integration' }) } } as unknown as Request;
  }

  it('processes simultaneous copies of one event exactly once', async () => {
    const p = await payment();
    const req = request(p);
    await Promise.all([service.handleWebhook(req), service.handleWebhook(req)]);
    expect((await db.getRepository(Order).findOneByOrFail({ id: order.id })).status).toBe(OrderStatus.CONFIRMED);
    expect(await db.getRepository(StripeWebhookEvent).countBy({ stripeEventId: eventIds[0] })).toBe(1);
    const paid = await db.getRepository(Payment).findOneByOrFail({ id: p.id });
    expect(paid.status).toBe(PaymentStatus.SUCCESS);
    await db.getRepository(Order).update(order.id, { status: OrderStatus.COMPLETED });
    await service.handleWebhook(request(p));
    expect((await db.getRepository(Order).findOneByOrFail({ id: order.id })).status).toBe(OrderStatus.COMPLETED);
    expect((await db.getRepository(Payment).findOneByOrFail({ id: p.id })).paidAt).toEqual(paid.paidAt);
  });

  it('rolls back payment and event writes if updating the order fails, then permits retry', async () => {
    const p = await payment();
    const req = request(p);
    const failing = new StripeWebhookService(config, { transaction: (work: any) => db.transaction(async (manager) => {
      jest.spyOn(manager.getRepository(Order), 'save').mockRejectedValue(new Error('injected order failure'));
      return work(manager);
    }) } as DataSource, new RefundsService(db, config));
    await expect(failing.handleWebhook(req)).rejects.toThrow('injected order failure');
    expect((await db.getRepository(Payment).findOneByOrFail({ id: p.id })).status).toBe(PaymentStatus.PENDING);
    expect((await db.getRepository(Order).findOneByOrFail({ id: order.id })).status).toBe(OrderStatus.PENDING);
    expect(await db.getRepository(StripeWebhookEvent).countBy({ stripeEventId: eventIds[0] })).toBe(0);
    await service.handleWebhook(req);
    expect((await db.getRepository(Order).findOneByOrFail({ id: order.id })).status).toBe(OrderStatus.CONFIRMED);
  });

  it('serializes two distinct successful payments and flags the extra charge for refund', async () => {
    const a = await payment();
    const b = await payment();
    await Promise.all([service.handleWebhook(request(a)), service.handleWebhook(request(b))]);
    expect((await db.getRepository(Order).findOneByOrFail({ id: order.id })).status).toBe(OrderStatus.PAYMENT_REQUIRES_REFUND);
    expect(await db.getRepository(Payment).countBy({ orderId: order.id, status: PaymentStatus.SUCCESS })).toBe(2);
  });

  it('cannot overwrite payment confirmation with a concurrent cancellation', async () => {
    const p = await payment();
    const orders = new OrdersService(db.getRepository(Order), {} as any, {} as any, {} as any, db);
    await Promise.allSettled([service.handleWebhook(request(p)), orders.cancel(order.id)]);
    const finalOrder = await db.getRepository(Order).findOneByOrFail({ id: order.id });
    expect([OrderStatus.CONFIRMED, OrderStatus.PAYMENT_REQUIRES_REFUND]).toContain(finalOrder.status);
    expect((await db.getRepository(Payment).findOneByOrFail({ id: p.id })).status).toBe(PaymentStatus.SUCCESS);
  });
});
