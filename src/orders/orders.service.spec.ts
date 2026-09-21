
import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './OrdersService.service';
import { Order } from './entity/Order.entity';
import { OrderItem } from './entity/order-item.entity';
import { Customer } from '../customers/entities/customer.entity';
import { Product } from '../products/entities/product.entity';
import { ProductStatus } from '../products/entities/product.entity';
import {  OrderStatus } from './entity/Order.entity';
describe('OrdersService', () => {
  let service: OrdersService;

  let orderRepository: jest.Mocked<Repository<Order>>;
  let orderItemRepository: jest.Mocked<Repository<OrderItem>>;
  let customerRepository: jest.Mocked<Repository<Customer>>;
  let productRepository: jest.Mocked<Repository<Product>>;
  // create() now runs the order + its items through a single transactional
  // EntityManager instead of the two injected repositories directly, so
  // that a failure while saving the items rolls back the order row too.
  // `manager` stands in for that EntityManager in tests.
  let manager: { create: jest.Mock; save: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    manager = {
      create: jest.fn((_entity: any, data: any) => data),
      save: jest.fn(async (a: any, b?: any) => (b !== undefined ? b : a)),
    };
    dataSource = {
      transaction: jest.fn((work: any) => work(manager)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        {
          provide: getRepositoryToken(Order),
          useValue: {
            update: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            find: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(OrderItem),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Customer),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Product),
          useValue: {
            find: jest.fn(),
          },
        },
        {
          provide: DataSource,
          useValue: dataSource,
        },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);

    orderRepository = module.get(getRepositoryToken(Order));
    orderItemRepository = module.get(getRepositoryToken(OrderItem));
    customerRepository = module.get(getRepositoryToken(Customer));
    productRepository = module.get(getRepositoryToken(Product));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create an order using the current product price, atomically', async () => {
      const customer = {
        id: 'customer-1',
      } as Customer;

    const products = [
  {
    id: 'prod-1',
    name: 'Test Product',
    description: null,
    sku: 'TEST-001',
    price: '10.00',
    costPrice: '5.00',
    status: ProductStatus.ACTIVE,
    categoryId: 'cat-1',
  },
] as unknown as Product[];

      const orderItems = [
        {
          id: 'item-1',
          orderId: 'order-1',
          productId: 'prod-1',
          quantity: 2,
          unitPrice: '10.00',
          subtotal: '20.00',
        },
      ] as OrderItem[];

      customerRepository.findOne.mockResolvedValue(customer);
      productRepository.find.mockResolvedValue(products);

      // manager.save() is called first for the order (single-arg) and then
      // for the items (two-arg); return a stable order id for the first call.
      manager.save.mockImplementationOnce(async (order: any) => ({ ...order, id: 'order-1' }));
      manager.save.mockImplementationOnce(async (_entity: any, items: any) => items);

      jest.spyOn(service, 'findById').mockResolvedValue({
        id: 'order-1',
        customerId: 'customer-1',
        subtotal: '20.00',
        totalAmount: '20.00',
        items: orderItems,
      } as Order);

      const result = await service.create({
        customerId: 'customer-1',
        items: [
          {
            productId: 'prod-1',
            quantity: 2,
          },
        ],
      });

      expect(customerRepository.findOne).toHaveBeenCalled();
      expect(productRepository.find).toHaveBeenCalled();

      // Both the order and its items are created/saved through the SAME
      // transactional manager, not the plain injected repositories.
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.create).toHaveBeenCalledWith(
        Order,
        expect.objectContaining({
          customerId: 'customer-1',
          subtotal: '20.00',
          totalAmount: '20.00',
        }),
      );
      expect(manager.create).toHaveBeenCalledWith(
        OrderItem,
        expect.objectContaining({
          orderId: 'order-1',
          productId: 'prod-1',
          quantity: 2,
          unitPrice: '10.00',
          subtotal: '20.00',
        }),
      );
      expect(manager.save).toHaveBeenCalledTimes(2);

      // The repositories injected at the class level are never touched by
      // create() anymore — only the transactional manager is.
      expect(orderRepository.create).not.toHaveBeenCalled();
      expect(orderRepository.save).not.toHaveBeenCalled();
      expect(orderItemRepository.create).not.toHaveBeenCalled();
      expect(orderItemRepository.save).not.toHaveBeenCalled();

      expect(result.id).toBe('order-1');
      expect(result.items).toEqual(orderItems);
    });

    it('should roll back and never call findById if saving the items fails', async () => {
      const customer = { id: 'customer-1' } as Customer;
      const products = [
        {
          id: 'prod-1',
          name: 'Test Product',
          price: '10.00',
          status: ProductStatus.ACTIVE,
        },
      ] as unknown as Product[];

      customerRepository.findOne.mockResolvedValue(customer);
      productRepository.find.mockResolvedValue(products);

      manager.save.mockImplementationOnce(async (order: any) => ({ ...order, id: 'order-1' }));
      manager.save.mockImplementationOnce(async () => {
        throw new Error('DB connection dropped while saving items');
      });

      const findByIdSpy = jest.spyOn(service, 'findById');

      await expect(
        service.create({
          customerId: 'customer-1',
          items: [{ productId: 'prod-1', quantity: 2 }],
        }),
      ).rejects.toThrow('DB connection dropped while saving items');

      // The whole thing ran inside one transaction() call, so the failed
      // item save means the order was never actually committed either —
      // there is nothing to look up afterward.
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(findByIdSpy).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when a product does not exist', async () => {
  const customer = {
  id: 'customer-1',
} as Customer;

customerRepository.findOne.mockResolvedValue(customer);

productRepository.find.mockResolvedValue([]);


await expect(
  service.create({
    customerId: 'customer-1',
    items: [
      {
        productId: 'prod-not-found',
        quantity: 2,
      },
    ],
  }),
).rejects.toThrow(NotFoundException);


expect(dataSource.transaction).not.toHaveBeenCalled();
});

it('should throw NotFoundException when customer does not exist', async () => {
  customerRepository.findOne.mockResolvedValue(null);

  await expect(
    service.create({
      customerId: 'customer-not-found',
      items: [
        {
          productId: 'prod-1',
          quantity: 2,
        },
      ],
    }),
  ).rejects.toThrow(NotFoundException);

  expect(productRepository.find).not.toHaveBeenCalled();
  expect(dataSource.transaction).not.toHaveBeenCalled();
});


it('should throw BadRequestException when product is inactive', async () => {
  const customer = {
    id: 'customer-1',
  } as Customer;

  const inactiveProduct = {
    id: 'prod-1',
    name: 'Inactive Product',
    description: null,
    sku: 'TEST-001',
    price: '10.00',
    costPrice: '5.00',
    status: ProductStatus.INACTIVE,
    categoryId: 'cat-1',
  } as unknown as Product;

  customerRepository.findOne.mockResolvedValue(customer);

  productRepository.find.mockResolvedValue([inactiveProduct]);

  await expect(
    service.create({
      customerId: 'customer-1',
      items: [
        {
          productId: 'prod-1',
          quantity: 2,
        },
      ],
    }),
  ).rejects.toThrow(BadRequestException);

  expect(dataSource.transaction).not.toHaveBeenCalled();
});
it('should throw BadRequestException when the same product is added twice', async () => {
  const customer = {
    id: 'customer-1',
  } as Customer;

  customerRepository.findOne.mockResolvedValue(customer);

  await expect(
    service.create({
      customerId: 'customer-1',
      items: [
        {
          productId: 'prod-1',
          quantity: 2,
        },
        {
          productId: 'prod-1',
          quantity: 1,
        },
      ],
    }),
  ).rejects.toThrow(BadRequestException);

  expect(productRepository.find).not.toHaveBeenCalled();
  expect(dataSource.transaction).not.toHaveBeenCalled();
});

it('should snapshot the product price in the order item', async () => {
  const customer = {
    id: 'customer-1',
  } as Customer;

  const product = {
    id: 'prod-1',
    name: 'Product 1',
    price: '10.00',
    status: ProductStatus.ACTIVE,
  } as unknown as Product;

  customerRepository.findOne.mockResolvedValue(customer);
  productRepository.find.mockResolvedValue([product]);

  manager.save.mockImplementationOnce(async (order: any) => ({ ...order, id: 'order-1' }));
  manager.save.mockImplementationOnce(async (_entity: any, items: any) => items);

  jest.spyOn(service, 'findById').mockResolvedValue({
    id: 'order-1',
    status: OrderStatus.PENDING,
    items: [
      {
        id: 'item-1',
        orderId: 'order-1',
        productId: 'prod-1',
        quantity: 2,
        unitPrice: '10.00',
        subtotal: '20.00',
      },
    ],
  } as Order);

  await service.create({
    customerId: 'customer-1',
    items: [{ productId: 'prod-1', quantity: 2 }],
  });

  // Product price is 10.00 at creation time
  expect(manager.create).toHaveBeenCalledWith(
    OrderItem,
    expect.objectContaining({
      unitPrice: '10.00',
      subtotal: '20.00',
    }),
  );
});

  });


  describe('cancel', () => {
  it('should cancel a pending order', async () => {
    const order = {
      id: 'order-1',
      status: OrderStatus.PENDING,
    } as Order;

    jest.spyOn(service, 'findById').mockResolvedValue(order);

    orderRepository.update.mockImplementation(async () => {
      order.status = OrderStatus.CANCELLED;
      return { affected: 1 } as never;
    });

    const result = await service.cancel('order-1');

    expect(service.findById).toHaveBeenCalledWith('order-1');

    expect(order.status).toBe(OrderStatus.CANCELLED);

    expect(orderRepository.update).toHaveBeenCalledWith(
      { id: 'order-1', status: OrderStatus.PENDING }, { status: OrderStatus.CANCELLED },
    );

    expect(result.status).toBe(OrderStatus.CANCELLED);
  });
  it('should reject cancelling a confirmed order', async () => {
  const order = {
    id: 'order-1',
    status: OrderStatus.CONFIRMED,
  } as Order;

  jest.spyOn(service, 'findById').mockResolvedValue(order);

  await expect(service.cancel('order-1')).rejects.toThrow(
    BadRequestException,
  );

  expect(orderRepository.save).not.toHaveBeenCalled();
});
});

describe('complete', () => {
  it('should complete a confirmed order', async () => {
    const order = {
      id: 'order-1',
      status: OrderStatus.CONFIRMED,
      completedAt: null,
    } as Order;

    jest.spyOn(service, 'findById').mockResolvedValue(order);

    orderRepository.update.mockImplementation(async () => {
      order.status = OrderStatus.COMPLETED;
      order.completedAt = new Date();
      return { affected: 1 } as never;
    });

    const result = await service.complete('order-1');

    expect(service.findById).toHaveBeenCalledWith('order-1');
    expect(order.status).toBe(OrderStatus.COMPLETED);
    expect(order.completedAt).toBeInstanceOf(Date);
    expect(orderRepository.update).toHaveBeenCalledWith(
      { id: 'order-1', status: OrderStatus.CONFIRMED },
      { status: OrderStatus.COMPLETED, completedAt: expect.any(Date) },
    );
    expect(result).toBe(order);
  });
});

it('should reject completing a pending order', async () => {
  const order = {
    id: 'order-1',
    status: OrderStatus.PENDING,
  } as Order;

  jest.spyOn(service, 'findById').mockResolvedValue(order);

  await expect(service.complete('order-1')).rejects.toThrow(
    BadRequestException,
  );

  expect(orderRepository.save).not.toHaveBeenCalled();
});
it('should reject an order with no items', async () => {
  await expect(
    service.create({
      customerId: 'customer-1',
      items: [],
    }),
  ).rejects.toThrow(BadRequestException);

  expect(customerRepository.findOne).not.toHaveBeenCalled();
  expect(dataSource.transaction).not.toHaveBeenCalled();
});

  it.each([
    ['cancel', OrderStatus.PENDING],
    ['complete', OrderStatus.CONFIRMED],
  ] as const)('rejects %s if a concurrent webhook changed the order', async (operation, status) => {
    jest.spyOn(service, 'findById').mockResolvedValue({ id: 'order-1', status } as Order);
    orderRepository.update.mockResolvedValue({ affected: 0 } as never);
    await expect(service[operation]('order-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(orderRepository.save).not.toHaveBeenCalled();
  });
});
