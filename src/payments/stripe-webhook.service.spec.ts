import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import Stripe from 'stripe';
import type { Request } from 'express';
import { StripeWebhookService } from './stripe-webhook.service';
import { StripeWebhookEvent } from './entity/stripe-webhook-event.entity';
import { Payment, PaymentProvider, PaymentStatus } from './entity/payment.entity';
import { Order, OrderStatus } from '../orders/entity/Order.entity';

const paymentId = '11111111-1111-4111-8111-111111111111';
const orderId = '22222222-2222-4222-8222-222222222222';
const webhookSecret = 'whsec_unit_test';
const stripe = new Stripe('sk_test_fake');

describe('StripeWebhookService payment confirmation', () => {
  let service: StripeWebhookService;
  let payment: any;
  let order: any;
  let stored: any;
  let payments: any;
  let orders: any;
  let events: any;
  let dataSource: any;
  let intent: any;

  const request = (value: any, eventId = 'evt_test'): Request => {
    const body = JSON.stringify({ id: eventId, type: 'payment_intent.succeeded', data: { object: value } });
    return { rawBody: Buffer.from(body), headers: {
      'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload: body, secret: webhookSecret }),
    } } as unknown as Request;
  };

  beforeEach(() => {
    payment = { id: paymentId, orderId, amount: '100.00', provider: PaymentProvider.STRIPE,
      providerTransactionId: 'pi_test', status: PaymentStatus.PENDING, paidAt: null };
    order = { id: orderId, totalAmount: '100.00', status: OrderStatus.PENDING };
    stored = { id: 'stored-event', processedAt: null };
    intent = { id: 'pi_test', metadata: { flowdeskPaymentId: paymentId, orderId },
      status: 'succeeded', currency: 'usd', amount: 10000, amount_received: 10000 };
    const insert: any = {};
    for (const name of ['insert', 'values', 'orIgnore']) insert[name] = jest.fn().mockReturnValue(insert);
    insert.execute = jest.fn().mockResolvedValue({});
    events = { createQueryBuilder: jest.fn().mockReturnValue(insert), findOneOrFail: jest.fn(async () => stored),
      update: jest.fn(async (_id, changes) => Object.assign(stored, changes)) };
    payments = { findOneBy: jest.fn(async () => payment), findOneOrFail: jest.fn(async () => payment),
      existsBy: jest.fn().mockResolvedValue(false), save: jest.fn(async (value) => value) };
    orders = { findOne: jest.fn(async () => order), save: jest.fn(async (value) => value) };
    const manager = { getRepository: (entity: unknown) => entity === StripeWebhookEvent ? events : entity === Payment ? payments : orders };
    dataSource = { transaction: jest.fn(async (callback) => callback(manager)) };
    service = new StripeWebhookService(new ConfigService({ STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: webhookSecret }), dataSource);
  });

  it('confirms the pending order and saves payment success before marking the event processed', async () => {
    await expect(service.handleWebhook(request(intent))).resolves.toMatchObject({ received: true });
    expect(payment.status).toBe(PaymentStatus.SUCCESS);
    expect(payment.paidAt).toBeInstanceOf(Date);
    expect(order.status).toBe(OrderStatus.CONFIRMED);
    expect(orders.save.mock.invocationCallOrder[0]).toBeLessThan(events.update.mock.invocationCallOrder[0]);
    expect(orders.findOne).toHaveBeenCalledWith(expect.objectContaining({ lock: { mode: 'pessimistic_write' } }));
  });

  it('acknowledges repeated deliveries without repeating updates', async () => {
    const req = request(intent);
    await service.handleWebhook(req);
    await service.handleWebhook(req);
    expect(payments.save).toHaveBeenCalledTimes(1);
    expect(orders.save).toHaveBeenCalledTimes(1);
  });

  it.each([OrderStatus.CONFIRMED, OrderStatus.COMPLETED, OrderStatus.REFUNDED])(
    'does not regress a %s order when another event reports the same successful payment', async (status) => {
      payment.status = PaymentStatus.SUCCESS;
      payment.paidAt = new Date('2026-01-01');
      order.status = status;
      await service.handleWebhook(request(intent, 'evt_another'));
      expect(order.status).toBe(status);
      expect(payments.save).not.toHaveBeenCalled();
      expect(orders.save).not.toHaveBeenCalled();
    },
  );

  it('marks a payment arriving after cancellation as requiring refund', async () => {
    order.status = OrderStatus.CANCELLED;
    await service.handleWebhook(request(intent));
    expect(payment.status).toBe(PaymentStatus.SUCCESS);
    expect(order.status).toBe(OrderStatus.PAYMENT_REQUIRES_REFUND);
  });

  it('marks an extra successful payment as requiring refund', async () => {
    payments.existsBy.mockResolvedValue(true);
    await service.handleWebhook(request(intent));
    expect(order.status).toBe(OrderStatus.PAYMENT_REQUIRES_REFUND);
  });

  it('handles a webhook arriving before the create-payment response is saved', async () => {
    payment.providerTransactionId = null;
    await service.handleWebhook(request(intent));
    expect(payment.providerTransactionId).toBe('pi_test');
    expect(order.status).toBe(OrderStatus.CONFIRMED);
  });

  it.each(['amount', 'amount_received', 'currency', 'id', 'orderId'])(
    'rejects mismatched %s without acknowledging it as processed', async (field) => {
      if (field === 'orderId') intent.metadata.orderId = 'other-order';
      else intent[field] = field === 'amount' || field === 'amount_received' ? 1 : 'wrong';
      await expect(service.handleWebhook(request(intent))).rejects.toBeInstanceOf(BadRequestException);
      expect(events.update).not.toHaveBeenCalled();
      expect(payments.save).not.toHaveBeenCalled();
    },
  );

  it('does not label a database failure as an invalid signature', async () => {
    const failure = new Error('database unavailable');
    orders.save.mockRejectedValue(failure);
    await expect(service.handleWebhook(request(intent))).rejects.toBe(failure);
    expect(events.update).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature before opening a transaction', async () => {
    const req = request(intent);
    req.headers['stripe-signature'] = 'invalid';
    await expect(service.handleWebhook(req)).rejects.toThrow('Invalid Stripe signature');
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});
