import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { PaymentsService } from './payments.service';
import {
  Payment,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
} from './entity/payment.entity';
import { Order, OrderStatus } from '../orders/entity/Order.entity';

const mockPaymentIntentsCreate = jest.fn();
const mockPaymentIntentsRetrieve = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    paymentIntents: {
      create: mockPaymentIntentsCreate,
      retrieve: mockPaymentIntentsRetrieve,
    },
  }));
});

describe('PaymentsService', () => {
  let service: PaymentsService;
  let paymentRepository: jest.Mocked<Repository<Payment>>;
  let orderRepository: jest.Mocked<Repository<Order>>;

  beforeEach(async () => {
    mockPaymentIntentsCreate.mockReset();
    mockPaymentIntentsRetrieve.mockReset();

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

  describe('resuming an existing idempotencyKey instead of rejecting it', () => {
    it('returns the existing payment as-is when it already succeeded', async () => {
      const existingPayment = {
        id: 'payment-1',
        idempotencyKey: 'key-1',
        status: PaymentStatus.SUCCESS,
        providerTransactionId: 'pi_test_123',
      } as Payment;

      paymentRepository.findOne.mockResolvedValue(existingPayment);

      const result = await service.create({
        orderId: 'order-1',
        idempotencyKey: 'key-1',
      });

      expect(result).toBe(existingPayment);
      expect(orderRepository.findOne).not.toHaveBeenCalled();
      expect(paymentRepository.create).not.toHaveBeenCalled();
      expect(paymentRepository.save).not.toHaveBeenCalled();
      expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
      expect(mockPaymentIntentsRetrieve).not.toHaveBeenCalled();
    });

    it('syncs the status from Stripe when a PaymentIntent id already exists', async () => {
      const existingPayment = {
        id: 'payment-1',
        idempotencyKey: 'key-1',
        status: PaymentStatus.PENDING,
        providerTransactionId: 'pi_test_123',
      } as Payment;

      const settledPayment = { ...existingPayment, status: PaymentStatus.SUCCESS };

      paymentRepository.findOne.mockResolvedValue(existingPayment);
      mockPaymentIntentsRetrieve.mockResolvedValue({ status: 'succeeded' });
      paymentRepository.update.mockResolvedValue({ affected: 1 } as never);
      paymentRepository.findOneByOrFail.mockResolvedValue(settledPayment);

      const result = await service.create({
        orderId: 'order-1',
        idempotencyKey: 'key-1',
      });

      expect(mockPaymentIntentsRetrieve).toHaveBeenCalledWith('pi_test_123');
      expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
      expect(paymentRepository.update).toHaveBeenCalledWith('payment-1', {
        status: PaymentStatus.SUCCESS,
        paidAt: expect.any(Date),
      });
      expect(result).toBe(settledPayment);
    });

    it('retries the Stripe call with the same idempotencyKey when no PaymentIntent id was ever recorded', async () => {
      const existingPayment = {
        id: 'payment-1',
        orderId: 'order-1',
        amount: '100.00',
        idempotencyKey: 'key-1',
        status: PaymentStatus.PENDING,
        providerTransactionId: null,
      } as Payment;

      const resumedPayment = { ...existingPayment, providerTransactionId: 'pi_test_456' };

      paymentRepository.findOne.mockResolvedValue(existingPayment);
      mockPaymentIntentsCreate.mockResolvedValue({ id: 'pi_test_456' });
      paymentRepository.update.mockResolvedValue({ affected: 1 } as never);
      paymentRepository.findOneByOrFail.mockResolvedValue(resumedPayment);

      const result = await service.create({
        orderId: 'order-1',
        idempotencyKey: 'key-1',
      });

      expect(mockPaymentIntentsRetrieve).not.toHaveBeenCalled();
      expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
        {
          amount: 10000,
          currency: 'usd',
          metadata: {
            flowdeskPaymentId: 'payment-1',
            orderId: 'order-1',
          },
        },
        { idempotencyKey: 'key-1' },
      );
      expect(paymentRepository.update).toHaveBeenCalledWith('payment-1', {
        providerTransactionId: 'pi_test_456',
      });
      expect(result).toBe(resumedPayment);
    });
  });
});
