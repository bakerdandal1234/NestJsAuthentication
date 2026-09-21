import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Order, OrderStatus } from './entity/Order.entity';
import { OrderItem } from './entity/order-item.entity';
import { Customer } from '../customers/entities/customer.entity';
import { Product, ProductStatus } from '../products/entities/product.entity';
import { CreateOrderDto } from './dto/CreateOrderDto.dto';

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,

    @InjectRepository(OrderItem)
    private readonly orderItemRepository: Repository<OrderItem>,

    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,

    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
  ) {}

  async create(dto: CreateOrderDto): Promise<Order> {
    if (dto.items.length === 0) {
      throw new BadRequestException('Order must contain at least one item');
    }

    const customer = await this.customerRepository.findOne({
      where: { id: dto.customerId },
    });

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    const productIds = dto.items.map((item) => item.productId);

    if (new Set(productIds).size !== productIds.length) {
      throw new BadRequestException(
        'Duplicate products are not allowed in the same order',
      );
    }

    // In(), not findByIds() -- findByIds() is deprecated in TypeORM 0.3.
    const products = await this.productRepository.find({
      where: { id: In(productIds) },
    });

    if (products.length !== productIds.length) {
      throw new NotFoundException('One or more products not found');
    }

    const productMap = new Map(
      products.map((product) => [product.id, product]),
    );

    const items = dto.items.map((item) => {
      const product = productMap.get(item.productId);

      if (!product) {
        throw new NotFoundException(
          `Product ${item.productId} not found`,
        );
      }

      if (product.status !== ProductStatus.ACTIVE) {
        throw new BadRequestException(
          `Product ${product.name} is inactive`,
        );
      }

      const unitPrice = Number(product.price);
      const subtotal = unitPrice * item.quantity;

      return {
        productId: product.id,
        quantity: item.quantity,
        unitPrice: unitPrice.toFixed(2),
        subtotal: subtotal.toFixed(2),
      };
    });

    const subtotal = items.reduce(
      (sum, item) => sum + Number(item.subtotal),
      0,
    );

    const order = this.orderRepository.create({
      customerId: customer.id,
      status: OrderStatus.PENDING,
      subtotal: subtotal.toFixed(2),
      totalAmount: subtotal.toFixed(2),
    });

    const savedOrder = await this.orderRepository.save(order);

    const orderItems = items.map((item) =>
      this.orderItemRepository.create({
        orderId: savedOrder.id,
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        subtotal: item.subtotal,
      }),
    );

    await this.orderItemRepository.save(orderItems);

    return this.findById(savedOrder.id);
  }

  async findById(id: string): Promise<Order> {
    const order = await this.orderRepository.findOne({
      where: { id },
      relations: {
        items: true,
        customer: true,
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    return order;
  }

  async findAll(): Promise<Order[]> {
    return this.orderRepository.find({
      relations: {
        items: true,
      },
      order: {
        createdAt: 'DESC',
      },
    });
  }

  async cancel(id: string): Promise<Order> {
    const order = await this.findById(id);

    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException(
        'Only pending orders can be cancelled',
      );
    }

    const changed = await this.orderRepository.update(
      { id, status: OrderStatus.PENDING }, { status: OrderStatus.CANCELLED },
    );
    if (changed.affected !== 1) {
      throw new BadRequestException('Only pending orders can be cancelled');
    }
    return this.findById(id);
  }

  async complete(id: string): Promise<Order> {
    const order = await this.findById(id);

    if (order.status !== OrderStatus.CONFIRMED) {
      throw new BadRequestException(
        'Only confirmed orders can be completed',
      );
    }

    const changed = await this.orderRepository.update(
      { id, status: OrderStatus.CONFIRMED },
      { status: OrderStatus.COMPLETED, completedAt: new Date() },
    );
    if (changed.affected !== 1) {
      throw new BadRequestException('Only confirmed orders can be completed');
    }
    return this.findById(id);
  }
}