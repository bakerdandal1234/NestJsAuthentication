import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager, In } from 'typeorm';
import Stripe from 'stripe';

import {
  Payment,
  PaymentProvider,
  PaymentStatus,
} from './entity/payment.entity';
import { Refund, RefundStatus } from './entity/refund.entity';
import { CreateRefundDto } from './dto/create-refund.dto';
import { Order, OrderStatus } from '../orders/entity/Order.entity';

@Injectable()
export class RefundsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Reserve a full refund before calling Stripe. The payment lock serializes
   * different idempotency keys, while the persisted refund id supplies a stable,
   * namespaced Stripe key across retries and application restarts. Network calls
   * that can move money happen only after the reservation has committed.
   */
  async create(dto: CreateRefundDto): Promise<Refund> {
    const stripe = this.getStripeClient();
    let reservation: { refund: Refund; payment: Payment };
    try {
      reservation = await this.dataSource.transaction(async (manager) => {
        const refunds = manager.getRepository(Refund);
        const payment = await manager.getRepository(Payment).findOne({
          where: { id: dto.paymentId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!payment) throw new NotFoundException('Payment not found');
        const existing = await refunds.findOneBy({
          idempotencyKey: dto.idempotencyKey,
        });
        if (existing) {
          if (
            existing.paymentId !== dto.paymentId ||
            existing.reason !== dto.reason
          ) {
            throw new ConflictException(
              'Idempotency key belongs to a different refund request',
            );
          }
          return { refund: existing, payment };
        }
        if (payment.status !== PaymentStatus.SUCCESS) {
          throw new ConflictException(
            'Only successful payments can be refunded',
          );
        }
        if (
          payment.provider !== PaymentProvider.STRIPE ||
          !payment.providerTransactionId
        ) {
          throw new ConflictException(
            'Payment has no refundable Stripe transaction',
          );
        }
        this.toCents(payment.amount);
        const active = await refunds.findOneBy({
          paymentId: payment.id,
          status: In([RefundStatus.PENDING, RefundStatus.SUCCESS]),
        });
        if (active)
          throw new ConflictException(
            'Payment already has a pending or successful refund',
          );
        const refund = await refunds.save(
          refunds.create({
            paymentId: payment.id,
            amount: payment.amount,
            status: RefundStatus.PENDING,
            providerRefundId: null,
            idempotencyKey: dto.idempotencyKey,
            reason: dto.reason,
            completedAt: null,
          }),
        );
        return { refund, payment };
      });
    } catch (error) {
      // Different payment-row locks cannot serialize a globally unique key.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        throw new ConflictException(
          'Idempotency key belongs to another refund request',
        );
      }
      throw error;
    }

    const { refund, payment } = reservation;
    if (refund.status !== RefundStatus.PENDING) return refund;
    if (
      payment.provider !== PaymentProvider.STRIPE ||
      !payment.providerTransactionId
    ) {
      throw new ConflictException(
        'Payment has no refundable Stripe transaction',
      );
    }
    let providerRefundId = refund.providerRefundId;
    if (!providerRefundId) {
      /**
       * Stripe can prune idempotency keys after 24 hours. Recover a previously
       * accepted refund by durable metadata before re-sending a creation request,
       * including for old PENDING rows left by the previous service.
       */
      try {
        for await (const candidate of stripe.refunds.list({
          payment_intent: payment.providerTransactionId,
          limit: 100,
        })) {
          if (candidate.metadata?.flowdeskRefundId === refund.id) {
            providerRefundId = candidate.id;
            break;
          }
        }
      } catch {
        throw new ServiceUnavailableException(
          'Unable to check Stripe refunds; retry with the same idempotency key',
        );
      }
      if (!providerRefundId) {
        try {
          const created = await stripe.refunds.create(
            {
              payment_intent: payment.providerTransactionId,
              amount: this.toCents(refund.amount),
              metadata: {
                flowdeskRefundId: refund.id,
                flowdeskPaymentId: payment.id,
              },
              // The DTO reason is free text, not Stripe's restricted reason enum.
              // Keep it locally instead of sending arbitrary text as that enum.
            },
            { idempotencyKey: `flowdesk-refund:${refund.id}` },
          );
          providerRefundId = created.id;
        } catch (error) {
          if (
            error instanceof Stripe.errors.StripeInvalidRequestError &&
            error.code !== 'idempotency_key_in_use' &&
            (error.statusCode === 400 || error.statusCode === 404)
          ) {
            // A definitive rejection created no refund. This cannot overwrite
            // a webhook that already settled the reservation.
            await this.dataSource
              .getRepository(Refund)
              .createQueryBuilder()
              .update()
              .set({ status: RefundStatus.FAILED, completedAt: new Date() })
              .where('id = :id', { id: refund.id })
              .andWhere('status = :status', { status: RefundStatus.PENDING })
              .andWhere('"providerRefundId" IS NULL')
              .execute();
            throw new BadRequestException('Stripe rejected the refund request');
          }
          // Timeouts, rate limits and server errors leave the reservation
          // pending: creating a new key here could move money twice.
          throw new ServiceUnavailableException(
            'Stripe refund outcome is unknown; retry with the same idempotency key',
          );
        }
      }
    }
    return this.dataSource.transaction(async (manager) => {
      const result = await this.synchronize(
        manager,
        providerRefundId!,
        refund.id,
      );
      if (!result) throw new NotFoundException('Refund not found');
      return result;
    });
  }

  /**
   * Used by POST and signed webhooks. Locate only refunds owned by this app;
   * unrelated Dashboard refunds do not create local records. Lock order ->
   * payment -> refund, matching the payment webhook order. Retrieve Stripe's
   * CURRENT state after locking so delayed events and slow POST responses cannot
   * overwrite a newer state. A bank rejection can change SUCCESS to FAILED, so
   * success is not blindly terminal. This bounded read holds locks deliberately
   * to serialize state observations; money-moving requests stay outside locks.
   */
  async synchronize(
    manager: EntityManager,
    providerRefundId: string,
    refundId?: string,
  ): Promise<Refund | null> {
    const refunds = manager.getRepository(Refund);
    const reference = await refunds.findOne({
      where: [
        { providerRefundId },
        ...(refundId && isUUID(refundId) ? [{ id: refundId }] : []),
      ],
    });
    if (!reference) return null;
    const payments = manager.getRepository(Payment);
    const paymentReference = await payments.findOneByOrFail({
      id: reference.paymentId,
    });
    const orders = manager.getRepository(Order);
    const order = await orders.findOneOrFail({
      where: { id: paymentReference.orderId },
      lock: { mode: 'pessimistic_write' },
    });
    const payment = await payments.findOneOrFail({
      where: { id: reference.paymentId },
      lock: { mode: 'pessimistic_write' },
    });
    const refund = await refunds.findOneOrFail({
      where: { id: reference.id },
      lock: { mode: 'pessimistic_write' },
    });
    let current: Stripe.Refund;
    try {
      current = await this.getStripeClient().refunds.retrieve(providerRefundId);
    } catch {
      // Also roll back the webhook event marker to permit redelivery.
      throw new ServiceUnavailableException(
        'Unable to retrieve Stripe refund status',
      );
    }
    const intentId =
      typeof current.payment_intent === 'string'
        ? current.payment_intent
        : current.payment_intent?.id;
    if (
      current.id !== providerRefundId ||
      (refund.providerRefundId && refund.providerRefundId !== current.id) ||
      current.metadata?.flowdeskRefundId !== refund.id ||
      current.metadata?.flowdeskPaymentId !== payment.id ||
      payment.provider !== PaymentProvider.STRIPE ||
      intentId !== payment.providerTransactionId ||
      current.currency !== 'usd' ||
      current.amount !== this.toCents(refund.amount) ||
      current.amount !== this.toCents(payment.amount)
    ) {
      throw new BadRequestException(
        'Stripe refund does not match the stored payment and refund',
      );
    }
    let status: RefundStatus;
    switch (current.status) {
      case 'succeeded':
        status = RefundStatus.SUCCESS;
        break;
      case 'failed':
      case 'canceled':
        status = RefundStatus.FAILED;
        break;
      case 'pending':
      case 'requires_action':
        status = RefundStatus.PENDING;
        break;
      default:
        throw new BadRequestException('Unsupported Stripe refund status');
    }
    const previousStatus = refund.status;
    refund.providerRefundId = current.id;
    refund.status = status;
    refund.completedAt =
      status === RefundStatus.PENDING
        ? null
        : previousStatus === status && refund.completedAt
          ? refund.completedAt
          : new Date();
    await refunds.save(refund);

    /**
     * Payment.SUCCESS records the original charge, not its net balance. An
     * order is REFUNDED only when every successful charge is fully returned;
     * refunding a duplicate charge must not label retained money as refunded.
     * Keep ambiguous multi-payment orders flagged for review.
     */
    const paid = await payments.find({
      where: { orderId: order.id, status: PaymentStatus.SUCCESS },
      relations: { refunds: true },
    });
    const fullyRefunded =
      paid.length > 0 &&
      paid.every(
        (item) =>
          item.refunds
            .filter((value) => value.status === RefundStatus.SUCCESS)
            .reduce((sum, value) => sum + this.toCents(value.amount), 0) >=
          this.toCents(item.amount),
      );
    const nextOrderStatus = fullyRefunded
      ? OrderStatus.REFUNDED
      : order.status === OrderStatus.REFUNDED
        ? OrderStatus.PAYMENT_REQUIRES_REFUND
        : order.status;
    if (nextOrderStatus !== order.status) {
      order.status = nextOrderStatus;
      await orders.save(order);
    }
    return refund;
  }

  /** USD is the payment service's currency; avoid floating-point rounding. */
  private toCents(amount: string): number {
    if (!/^\d+(\.\d{1,2})?$/.test(amount))
      throw new BadRequestException('Invalid refund amount');
    const [whole, fraction = ''] = amount.split('.');
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(cents) || cents <= 0)
      throw new BadRequestException('Invalid refund amount');
    return cents;
  }

  private getStripeClient(): Stripe {
    const secret = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (!secret)
      throw new BadRequestException('Stripe secret key is not configured');
    return new Stripe(secret, { timeout: 15000, maxNetworkRetries: 1 });
  }
}
