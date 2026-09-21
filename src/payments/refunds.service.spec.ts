import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import {
  Payment,
  PaymentProvider,
  PaymentStatus,
} from './entity/payment.entity';
import { Refund, RefundStatus } from './entity/refund.entity';
import { Order, OrderStatus } from '../orders/entity/Order.entity';
import { RefundsService } from './refunds.service';

const paymentId = '11111111-1111-4111-8111-111111111111';
const refundId = '22222222-2222-4222-8222-222222222222';
const orderId = '33333333-3333-4333-8333-333333333333';

describe('RefundsService', () => {
  let service: RefundsService;
  let payment: any;
  let order: any;
  let refund: any;
  let remote: any;
  let stripe: any;
  let refunds: any;
  let payments: any;
  let orders: any;
  let manager: any;
  let db: any;
  let update: any;
  let dto: any;
  let candidates: any[];

  beforeEach(() => {
    dto = {
      paymentId,
      idempotencyKey: 'refund-key',
      reason: 'Customer requested a return',
    };
    payment = {
      id: paymentId,
      orderId,
      amount: '100.00',
      status: PaymentStatus.SUCCESS,
      provider: PaymentProvider.STRIPE,
      providerTransactionId: 'pi_test',
    };
    order = { id: orderId, status: OrderStatus.CONFIRMED };
    refund = null;
    candidates = [];
    remote = {
      id: 're_test',
      payment_intent: 'pi_test',
      amount: 10000,
      currency: 'usd',
      status: 'succeeded',
      metadata: { flowdeskRefundId: refundId, flowdeskPaymentId: paymentId },
    };
    stripe = {
      refunds: {
        list: jest.fn(() =>
          (async function* () {
            yield* candidates;
          })(),
        ),
        create: jest.fn(async () => remote),
        retrieve: jest.fn(async () => remote),
      },
    };
    update = {};
    for (const name of ['update', 'set', 'where', 'andWhere'])
      update[name] = jest.fn().mockReturnValue(update);
    update.execute = jest.fn().mockResolvedValue({ affected: 1 });
    refunds = {
      findOneBy: jest.fn(async (where) => {
        if ('idempotencyKey' in where)
          return refund?.idempotencyKey === where.idempotencyKey
            ? refund
            : null;
        return refund && refund.status !== RefundStatus.FAILED ? refund : null;
      }),
      create: jest.fn((data) => ({
        id: refundId,
        createdAt: new Date(),
        ...data,
      })),
      save: jest.fn(async (value) => {
        refund = value;
        return value;
      }),
      findOne: jest.fn(async () => refund),
      findOneOrFail: jest.fn(async () => refund),
      createQueryBuilder: jest.fn(() => update),
    };
    payments = {
      findOne: jest.fn(async () => payment),
      findOneByOrFail: jest.fn(async () => payment),
      findOneOrFail: jest.fn(async () => payment),
      find: jest.fn(async () => [
        { ...payment, refunds: refund ? [refund] : [] },
      ]),
    };
    orders = {
      findOneOrFail: jest.fn(async () => order),
      save: jest.fn(async (value) => value),
    };
    manager = {
      getRepository: (entity: unknown) =>
        entity === Refund ? refunds : entity === Payment ? payments : orders,
    };
    db = {
      transaction: jest.fn(async (work) => work(manager)),
      getRepository: manager.getRepository,
    };
    service = new RefundsService(
      db,
      new ConfigService({ STRIPE_SECRET_KEY: 'sk_test_fake' }),
    );
    jest.spyOn(service as any, 'getStripeClient').mockReturnValue(stripe);
  });

  function existing(
    status = RefundStatus.PENDING,
    providerRefundId: string | null = null,
  ) {
    refund = {
      id: refundId,
      paymentId,
      amount: '100.00',
      idempotencyKey: dto.idempotencyKey,
      reason: dto.reason,
      status,
      providerRefundId,
      completedAt: null,
      createdAt: new Date('2020-01-01'),
    };
  }

  it('reserves the full amount, calls Stripe, and marks refund/order successful', async () => {
    const result = await service.create(dto);
    expect(result).toMatchObject({
      status: RefundStatus.SUCCESS,
      providerRefundId: 're_test',
      completedAt: expect.any(Date),
    });
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      {
        payment_intent: 'pi_test',
        amount: 10000,
        metadata: { flowdeskRefundId: refundId, flowdeskPaymentId: paymentId },
      },
      { idempotencyKey: `flowdesk-refund:${refundId}` },
    );
    expect(refunds.save.mock.invocationCallOrder[0]).toBeLessThan(
      stripe.refunds.create.mock.invocationCallOrder[0],
    );
    expect(payments.findOne).toHaveBeenCalledWith({
      where: { id: paymentId },
      lock: { mode: 'pessimistic_write' },
    });
    expect(order.status).toBe(OrderStatus.REFUNDED);
    expect(payment.status).toBe(PaymentStatus.SUCCESS);
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });

  it.each(['pending', 'requires_action'])(
    'keeps %s refunds pending without refunding the order',
    async (status) => {
      remote.status = status;
      await service.create(dto);
      expect(refund.status).toBe(RefundStatus.PENDING);
      expect(refund.completedAt).toBeNull();
      expect(refund.providerRefundId).toBe('re_test');
      expect(order.status).toBe(OrderStatus.CONFIRMED);
    },
  );

  it.each(['failed', 'canceled'])(
    'records a Stripe %s refund as failed',
    async (status) => {
      remote.status = status;
      await service.create(dto);
      expect(refund.status).toBe(RefundStatus.FAILED);
      expect(refund.completedAt).toBeInstanceOf(Date);
      expect(orders.save).not.toHaveBeenCalled();
    },
  );

  it.each([RefundStatus.SUCCESS, RefundStatus.FAILED])(
    'returns the same terminal %s result on retry',
    async (status) => {
      existing(status);
      expect(await service.create(dto)).toBe(refund);
      expect(stripe.refunds.create).not.toHaveBeenCalled();
      expect(stripe.refunds.retrieve).not.toHaveBeenCalled();
    },
  );

  it('reconciles a known pending provider refund without creating another', async () => {
    existing(RefundStatus.PENDING, 're_test');
    await service.create(dto);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(stripe.refunds.list).not.toHaveBeenCalled();
    expect(stripe.refunds.retrieve).toHaveBeenCalledWith('re_test');
  });

  it('recovers a lost response by metadata even after the idempotency retention window', async () => {
    existing();
    candidates = [{ ...remote, id: 're_unrelated', metadata: {} }, remote];
    await service.create(dto);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(refund.status).toBe(RefundStatus.SUCCESS);
  });

  it('resumes old pending-only records using their original amount and stable provider key', async () => {
    existing();
    await service.create(dto);
    expect(refunds.create).not.toHaveBeenCalled();
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
  });

  it.each(['paymentId', 'reason'])(
    'rejects reuse of a key with different %s',
    async (field) => {
      existing();
      refund[field] = 'different';
      await expect(service.create(dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(stripe.refunds.create).not.toHaveBeenCalled();
    },
  );

  it.each([RefundStatus.PENDING, RefundStatus.SUCCESS])(
    'blocks a new key when a %s refund exists',
    async (status) => {
      existing(status);
      refund.idempotencyKey = 'earlier-key';
      await expect(service.create(dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(stripe.refunds.create).not.toHaveBeenCalled();
    },
  );

  it('permits a new request after a definitively failed refund', async () => {
    existing(RefundStatus.FAILED);
    refund.idempotencyKey = 'earlier-key';
    await service.create(dto);
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
  });

  it('does not create a reservation for a missing payment', async () => {
    payment = null;
    await expect(service.create(dto)).rejects.toBeInstanceOf(NotFoundException);
    expect(refunds.save).not.toHaveBeenCalled();
  });

  it.each(['status', 'provider', 'providerTransactionId'])(
    'rejects a nonrefundable payment: %s',
    async (field) => {
      payment[field] = field === 'providerTransactionId' ? null : 'invalid';
      await expect(service.create(dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(refunds.save).not.toHaveBeenCalled();
      expect(stripe.refunds.create).not.toHaveBeenCalled();
    },
  );

  it.each(['0.00', '-1.00', '1.234', 'NaN', '9007199254740992.00'])(
    'rejects invalid amount %s',
    async (amount) => {
      payment.amount = amount;
      await expect(service.create(dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(stripe.refunds.create).not.toHaveBeenCalled();
    },
  );

  it('preserves a pending reservation on a timeout and recovers it on retry', async () => {
    stripe.refunds.create.mockRejectedValueOnce(
      new Stripe.errors.StripeConnectionError({ message: 'timeout' }),
    );
    await expect(service.create(dto)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(refund.status).toBe(RefundStatus.PENDING);
    expect(update.execute).not.toHaveBeenCalled();
    candidates = [remote];
    await service.create(dto);
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
    expect(refund.status).toBe(RefundStatus.SUCCESS);
  });

  it('never creates a refund if recovery lookup failed', async () => {
    stripe.refunds.list.mockImplementation(() => {
      throw new Error('offline');
    });
    await expect(service.create(dto)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(refund.status).toBe(RefundStatus.PENDING);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it('marks a definitive Stripe rejection failed without overwriting a settled webhook', async () => {
    stripe.refunds.create.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        message: 'already refunded',
        statusCode: 400,
        code: 'charge_already_refunded',
      }),
    );
    await expect(service.create(dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(update.set).toHaveBeenCalledWith({
      status: RefundStatus.FAILED,
      completedAt: expect.any(Date),
    });
    expect(update.andWhere).toHaveBeenCalledWith('"providerRefundId" IS NULL');
    expect(update.andWhere).toHaveBeenCalledWith('status = :status', {
      status: RefundStatus.PENDING,
    });
  });

  it('keeps an in-flight idempotency conflict pending', async () => {
    stripe.refunds.create.mockRejectedValue(
      new Stripe.errors.StripeInvalidRequestError({
        message: 'in progress',
        statusCode: 400,
        code: 'idempotency_key_in_use',
      }),
    );
    await expect(service.create(dto)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(update.execute).not.toHaveBeenCalled();
  });

  it('maps a cross-payment unique key race to conflict', async () => {
    refunds.save.mockRejectedValue({ code: '23505' });
    await expect(service.create(dto)).rejects.toBeInstanceOf(ConflictException);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it('validates config before reserving a refund', async () => {
    const unconfigured = new RefundsService(db, new ConfigService());
    await expect(unconfigured.create(dto)).rejects.toThrow(
      'Stripe secret key is not configured',
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('retrieves current state only after locking order, payment and refund', async () => {
    existing();
    await service.synchronize(manager, remote.id, refund.id);
    const sequence = [
      orders.findOneOrFail,
      payments.findOneOrFail,
      refunds.findOneOrFail,
      stripe.refunds.retrieve,
    ].map((mock) => mock.mock.invocationCallOrder[0]);
    expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
    expect(orders.findOneOrFail).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
  });

  it('ignores refunds not owned by this application', async () => {
    expect(
      await service.synchronize(manager, 're_external', 'invalid-id'),
    ).toBeNull();
    expect(stripe.refunds.retrieve).not.toHaveBeenCalled();
  });

  it.each([
    'amount',
    'currency',
    'payment_intent',
    'id',
    'flowdeskRefundId',
    'flowdeskPaymentId',
  ])('rejects mismatched Stripe %s before persisting', async (field) => {
    existing();
    if (field.startsWith('flowdesk')) remote.metadata[field] = 'wrong';
    else remote[field] = field === 'amount' ? 1 : 'wrong';
    await expect(
      service.synchronize(manager, 're_test', refundId),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(refunds.save).not.toHaveBeenCalled();
    expect(orders.save).not.toHaveBeenCalled();
  });

  it('rejects switching the Stripe refund bound to a local record', async () => {
    existing(RefundStatus.PENDING, 're_other');
    await expect(
      service.synchronize(manager, 're_test', refundId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('leaves a duplicate-charge order flagged when another charge is still retained', async () => {
    existing();
    order.status = OrderStatus.PAYMENT_REQUIRES_REFUND;
    payments.find.mockImplementation(async () => [
      { ...payment, refunds: [refund] },
      { ...payment, id: 'other', refunds: [] },
    ]);
    await service.synchronize(manager, 're_test', refundId);
    expect(refund.status).toBe(RefundStatus.SUCCESS);
    expect(order.status).toBe(OrderStatus.PAYMENT_REQUIRES_REFUND);
  });

  it('marks the order refunded once all successful charges are refunded', async () => {
    existing();
    order.status = OrderStatus.PAYMENT_REQUIRES_REFUND;
    payments.find.mockImplementation(async () => [
      { ...payment, refunds: [refund] },
      {
        ...payment,
        id: 'other',
        refunds: [{ amount: '100.00', status: RefundStatus.SUCCESS }],
      },
    ]);
    await service.synchronize(manager, 're_test', refundId);
    expect(order.status).toBe(OrderStatus.REFUNDED);
  });

  it('records a later bank failure and reopens a refunded order for review', async () => {
    existing(RefundStatus.SUCCESS, 're_test');
    order.status = OrderStatus.REFUNDED;
    remote.status = 'failed';
    await service.synchronize(manager, 're_test', refundId);
    expect(refund.status).toBe(RefundStatus.FAILED);
    expect(order.status).toBe(OrderStatus.PAYMENT_REQUIRES_REFUND);
  });

  it('preserves completedAt when repeated deliveries report the same final status', async () => {
    existing(RefundStatus.SUCCESS, 're_test');
    const completedAt = new Date('2026-01-01');
    refund.completedAt = completedAt;
    order.status = OrderStatus.REFUNDED;
    await service.synchronize(manager, 're_test', refundId);
    expect(refund.completedAt).toBe(completedAt);
    expect(orders.save).not.toHaveBeenCalled();
  });

  it('propagates a failed status lookup without persisting refund/order changes', async () => {
    existing();
    stripe.refunds.retrieve.mockRejectedValue(new Error('offline'));
    await expect(
      service.synchronize(manager, 're_test', refundId),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(refunds.save).not.toHaveBeenCalled();
    expect(orders.save).not.toHaveBeenCalled();
  });

  it('propagates order persistence failure so the caller transaction cannot commit', async () => {
    existing();
    orders.save.mockRejectedValue(new Error('database failure'));
    await expect(
      service.synchronize(manager, 're_test', refundId),
    ).rejects.toThrow('database failure');
  });
});
