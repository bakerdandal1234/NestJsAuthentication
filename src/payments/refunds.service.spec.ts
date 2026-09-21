import {
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  Payment,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
} from './entity/payment.entity';
import { Refund, RefundStatus } from './entity/refund.entity';
import { RefundsService } from './refunds.service';

describe('RefundsService', () => {
  let service: RefundsService;
  let refundRepository: jest.Mocked<Repository<Refund>>;
  let paymentRepository: jest.Mocked<Repository<Payment>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefundsService,
        {
          provide: getRepositoryToken(Refund),
          useValue: {
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Payment),
          useValue: {
            findOne: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<RefundsService>(RefundsService);
    refundRepository = module.get(getRepositoryToken(Refund));
    paymentRepository = module.get(getRepositoryToken(Payment));
  });

  it('should create a pending refund using the payment amount', async () => {
    const payment = {
      id: 'payment-id',
      amount: '100.00',
      status: PaymentStatus.SUCCESS,
      method: PaymentMethod.CARD,
      provider: PaymentProvider.STRIPE,
    } as Payment;

    const dto = {
      paymentId: payment.id,
      idempotencyKey: 'refund-key-123',
      reason: 'Customer requested refund',
    };

    const refund = {
      id: 'refund-id',
      paymentId: payment.id,
      amount: '100.00',
      status: RefundStatus.PENDING,
      providerRefundId: null,
      idempotencyKey: dto.idempotencyKey,
      reason: dto.reason,
      completedAt: null,
    } as Refund;

    refundRepository.findOne.mockResolvedValue(null);
    paymentRepository.findOne.mockResolvedValue(payment);
    refundRepository.create.mockReturnValue(refund);
    refundRepository.save.mockResolvedValue(refund);

    const result = await service.create(dto);

    expect(result).toBe(refund);

    expect(refundRepository.create).toHaveBeenCalledWith({
      paymentId: payment.id,
      amount: payment.amount,
      status: RefundStatus.PENDING,
      providerRefundId: null,
      idempotencyKey: dto.idempotencyKey,
      reason: dto.reason,
      completedAt: null,
    });

    expect(refundRepository.save).toHaveBeenCalledWith(refund);
  });

  it('should throw NotFoundException when the payment does not exist', async () => {
    const dto = {
      paymentId: 'missing-payment-id',
      idempotencyKey: 'refund-key-123',
      reason: 'Customer requested refund',
    };

    refundRepository.findOne.mockResolvedValue(null);
    paymentRepository.findOne.mockResolvedValue(null);

    await expect(service.create(dto)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(refundRepository.create).not.toHaveBeenCalled();
    expect(refundRepository.save).not.toHaveBeenCalled();
  });

  it('should reject refund when payment is not successful', async () => {
    const payment = {
      id: 'payment-id',
      amount: '100.00',
      status: PaymentStatus.PENDING,
    } as Payment;

    const dto = {
      paymentId: payment.id,
      idempotencyKey: 'refund-key-123',
      reason: 'Customer requested refund',
    };

    refundRepository.findOne.mockResolvedValue(null);
    paymentRepository.findOne.mockResolvedValue(payment);

    await expect(service.create(dto)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(refundRepository.create).not.toHaveBeenCalled();
    expect(refundRepository.save).not.toHaveBeenCalled();
  });

  it('should reject a duplicate idempotency key', async () => {
    const existingRefund = {
      id: 'existing-refund-id',
      idempotencyKey: 'refund-key-123',
    } as Refund;

    const dto = {
      paymentId: 'payment-id',
      idempotencyKey: 'refund-key-123',
      reason: 'Customer requested refund',
    };

    refundRepository.findOne.mockResolvedValue(existingRefund);

    await expect(service.create(dto)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(paymentRepository.findOne).not.toHaveBeenCalled();
    expect(refundRepository.create).not.toHaveBeenCalled();
    expect(refundRepository.save).not.toHaveBeenCalled();
  });
});