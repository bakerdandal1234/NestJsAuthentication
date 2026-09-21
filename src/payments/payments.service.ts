import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Payment, PaymentMethod, PaymentProvider, PaymentStatus } from './entity/payment.entity';
import { Order, OrderStatus } from '../orders/entity/Order.entity';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

@Injectable()
export class PaymentsService {
  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,

    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    private readonly configService: ConfigService,
  ) {}

  async create(dto: CreatePaymentDto): Promise<Payment> {
    const existingPayment = await this.paymentRepository.findOne({
      where: { idempotencyKey: dto.idempotencyKey },
    });

    // A row with this idempotencyKey already exists: instead of always
    // rejecting it as a duplicate, resume the operation safely based on
    // how far the previous attempt actually got.
    if (existingPayment) {
      return this.resumeExistingPayment(existingPayment, dto);
    }

    const order = await this.orderRepository.findOne({
      where: { id: dto.orderId },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('Only pending orders can be paid');
    }

    const payment = this.paymentRepository.create({
      orderId: order.id,
      amount: order.totalAmount,
      method: PaymentMethod.CARD,
      status: PaymentStatus.PENDING,
      provider: PaymentProvider.STRIPE,
      providerTransactionId: null,
      idempotencyKey: dto.idempotencyKey,
      paidAt: null,
    });

    let savedPayment: Payment;
    try {
      savedPayment = await this.paymentRepository.save(payment);
    } catch (err) {
      // Unique violation on idempotencyKey: a concurrent request won the
      // race and inserted the row between our findOne() and save() above.
      // Resume that row instead of surfacing a raw DB error to the caller.
      if (this.isUniqueViolation(err)) {
        const racedPayment = await this.paymentRepository.findOneByOrFail({
          idempotencyKey: dto.idempotencyKey,
        });
        return this.resumeExistingPayment(racedPayment, dto);
      }
      throw err;
    }

    const stripe = this.getStripeClient();

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: Math.round(Number(savedPayment.amount) * 100),
        currency: 'usd',

        metadata: {
          flowdeskPaymentId: savedPayment.id,
          orderId: order.id,
        },
      },
      {
        idempotencyKey: dto.idempotencyKey,
      },
    );

    savedPayment.providerTransactionId = paymentIntent.id;

    // Update only this field: a fast webhook may already have marked payment SUCCESS.
    await this.paymentRepository.update(savedPayment.id, {
      providerTransactionId: paymentIntent.id,
    });
    return this.paymentRepository.findOneByOrFail({ id: savedPayment.id });
  }

  /**
   * Resumes an existing Payment row found by idempotencyKey instead of
   * rejecting the request as a duplicate. The connection to Stripe may have
   * dropped at any point in the previous attempt, so we resume based on how
   * far that attempt actually got, rather than assuming it either fully
   * succeeded or never started.
   */
  private async resumeExistingPayment(
    existingPayment: Payment,
    dto: CreatePaymentDto,
  ): Promise<Payment> {
    // 1) A previous attempt (or a webhook) already completed this payment.
    //    Idempotency means returning the same result, not an error.
    if (existingPayment.status === PaymentStatus.SUCCESS) {
      return existingPayment;
    }

    const stripe = this.getStripeClient();

    // 2) We already reached Stripe on a previous attempt and have a
    //    PaymentIntent id, but never confirmed the outcome locally (the
    //    connection likely dropped after Stripe responded). Ask Stripe
    //    directly instead of creating a second PaymentIntent.
    if (existingPayment.providerTransactionId) {
      const intent = await stripe.paymentIntents.retrieve(
        existingPayment.providerTransactionId,
      );

      if (intent.status === 'succeeded') {
        await this.paymentRepository.update(existingPayment.id, {
          status: PaymentStatus.SUCCESS,
          paidAt: new Date(),
        });
      } else if (
        intent.status === 'canceled' ||
        intent.status === 'requires_payment_method'
      ) {
        await this.paymentRepository.update(existingPayment.id, {
          status: PaymentStatus.FAILED,
        });
      }
      // Any other Stripe status (processing/requires_action/...) is left
      // PENDING as-is; the webhook will settle it when Stripe confirms.

      return this.paymentRepository.findOneByOrFail({ id: existingPayment.id });
    }

    // 3) The connection dropped before we ever got a response from Stripe
    //    for the original attempt. Re-send the exact same request with the
    //    same idempotencyKey: Stripe guarantees the same outcome as the
    //    original call, whether or not it actually reached their servers
    //    the first time.
    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: Math.round(Number(existingPayment.amount) * 100),
        currency: 'usd',
        metadata: {
          flowdeskPaymentId: existingPayment.id,
          orderId: existingPayment.orderId,
        },
      },
      { idempotencyKey: dto.idempotencyKey },
    );

    // Update only this field: a fast webhook may already have marked payment SUCCESS.
    await this.paymentRepository.update(existingPayment.id, {
      providerTransactionId: paymentIntent.id,
    });

    return this.paymentRepository.findOneByOrFail({ id: existingPayment.id });
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === '23505'
    );
  }

  private getStripeClient(): Stripe {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');

    if (!secretKey) {
      throw new BadRequestException('Stripe secret key is not configured');
    }

    return new Stripe(secretKey);
  }
}
