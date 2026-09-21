import {
  BadRequestException,
  ConflictException,
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

    if (existingPayment) {
      throw new ConflictException(
        'Payment with this idempotency key already exists',
      );
    }

    const order = await this.orderRepository.findOne({
      where: { id: dto.orderId },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException(
        'Only pending orders can be paid',
      );
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

    const savedPayment = await this.paymentRepository.save(payment);

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
  

  private getStripeClient(): Stripe {
  const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');

  if (!secretKey) {
    throw new BadRequestException('Stripe secret key is not configured');
  }

  return new Stripe(secretKey);
}


}