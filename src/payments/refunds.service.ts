import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Payment, PaymentStatus } from './entity/payment.entity';
import { Refund, RefundStatus } from './entity/refund.entity';
import { CreateRefundDto } from './dto/create-refund.dto';

@Injectable()
export class RefundsService {
  constructor(
    @InjectRepository(Refund)
    private readonly refundRepository: Repository<Refund>,

    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
  ) {}

  async create(dto: CreateRefundDto): Promise<Refund> {
    const existingRefund = await this.refundRepository.findOne({
      where: { idempotencyKey: dto.idempotencyKey },
    });

    if (existingRefund) {
      throw new ConflictException(
        'Refund with this idempotency key already exists',
      );
    }

    const payment = await this.paymentRepository.findOne({
      where: { id: dto.paymentId },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    if (payment.status !== PaymentStatus.SUCCESS) {
      throw new ConflictException(
        'Only successful payments can be refunded',
      );
    }

    const refund = this.refundRepository.create({
      paymentId: payment.id,
      amount: payment.amount,
      status: RefundStatus.PENDING,
      providerRefundId: null,
      idempotencyKey: dto.idempotencyKey,
      reason: dto.reason,
      completedAt: null,
    });

    return this.refundRepository.save(refund);
  }
}