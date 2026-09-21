import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import { PaymentsService } from './payments.service';
import {
  Payment,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
} from './entity/payment.entity';
import { Order, OrderStatus } from '../orders/entity/Order.entity';

const mockPaymentIntentsCreate = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    paymentIntents: {
      create: mockPaymentIntentsCreate,
    },
  }));
});

describe('PaymentsService', () => {
  let service: PaymentsService;
  let paymentRepository: jest.Mocked<Repository<Payment>>;
  let orderRepository: jest.Mocked<Repository<Order>>;

  beforeEach(async () => {
    mockPaymentIntentsCreate.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        {
          provide: getRepositoryToken(Payment),
          useValue: {
            findOne: jest.fn(),
            update: jest.fn(),
            findOneByOrFail: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Order),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('sk_test_fake'),
          },
        },
      ],
    }).compile();

    service = module.get(PaymentsService);
    paymentRepository = module.get(getRepositoryToken(Payment));
    orderRepository = module.get(getRepositoryToken(Order));
  });

  it('should create a pending Stripe payment using the order total', async () => {
    const order = {
      id: 'order-1',
      status: OrderStatus.PENDING,
      totalAmount: '100.00',
    } as Order;

    const payment = {
      id: 'payment-1',
      orderId: 'order-1',
      amount: '100.00',
      method: PaymentMethod.CARD,
      status: PaymentStatus.PENDING,
      provider: PaymentProvider.STRIPE,
      providerTransactionId: null,
      idempotencyKey: 'key-1',
      paidAt: null,
    } as Payment;

    paymentRepository.findOne.mockResolvedValue(null);
    orderRepository.findOne.mockResolvedValue(order);
    paymentRepository.create.mockReturnValue(payment);
    paymentRepository.save.mockResolvedValue(payment);
    paymentRepository.update.mockResolvedValue({ affected: 1 } as never);
    paymentRepository.findOneByOrFail.mockResolvedValue(payment);

    mockPaymentIntentsCreate.mockResolvedValue({
      id: 'pi_test_123',
    });

    const result = await service.create({
      orderId: 'order-1',
      idempotencyKey: 'key-1',
    });

    expect(paymentRepository.create).toHaveBeenCalledWith({
      orderId: 'order-1',
      amount: '100.00',
      method: PaymentMethod.CARD,
      status: PaymentStatus.PENDING,
      provider: PaymentProvider.STRIPE,
      providerTransactionId: null,
      idempotencyKey: 'key-1',
      paidAt: null,
    });

    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
      {
        amount: 10000,
        currency: 'usd',
        metadata: {
          flowdeskPaymentId: 'payment-1',
          orderId: 'order-1',
        },
      },
      {
        idempotencyKey: 'key-1',
      },
    );

    expect(payment.providerTransactionId).toBe('pi_test_123');

    expect(paymentRepository.save).toHaveBeenCalledTimes(1);
    expect(paymentRepository.update).toHaveBeenCalledWith(payment.id, { providerTransactionId: 'pi_test_123' });

    expect(result).toBe(payment);
  });

  it('should throw NotFoundException when the order does not exist', async () => {
    paymentRepository.findOne.mockResolvedValue(null);
    orderRepository.findOne.mockResolvedValue(null);

    await expect(
      service.create({
        orderId: 'order-1',
        idempotencyKey: 'key-1',
      }),
    ).rejects.toThrow(NotFoundException);

    expect(paymentRepository.create).not.toHaveBeenCalled();
    expect(paymentRepository.save).not.toHaveBeenCalled();
    expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
  });

  it('should reject payment for a non-pending order', async () => {
    const order = {
      id: 'order-1',
      status: OrderStatus.CONFIRMED,
      totalAmount: '100.00',
    } as Order;

    paymentRepository.findOne.mockResolvedValue(null);
    orderRepository.findOne.mockResolvedValue(order);

    await expect(
      service.create({
        orderId: 'order-1',
        idempotencyKey: 'key-2',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(paymentRepository.create).not.toHaveBeenCalled();
    expect(paymentRepository.save).not.toHaveBeenCalled();
    expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
  });

  it('should reject a duplicate idempotency key', async () => {
    const existingPayment = {
      id: 'payment-1',
      idempotencyKey: 'key-1',
    } as Payment;

    paymentRepository.findOne.mockResolvedValue(existingPayment);

    await expect(
      service.create({
        orderId: 'order-1',
        idempotencyKey: 'key-1',
      }),
    ).rejects.toThrow(ConflictException);

    expect(orderRepository.findOne).not.toHaveBeenCalled();
    expect(paymentRepository.create).not.toHaveBeenCalled();
    expect(paymentRepository.save).not.toHaveBeenCalled();
    expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
  });
});