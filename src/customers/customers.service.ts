import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Customer } from './entities/customer.entity';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { ListCustomersQueryDto } from './dto/list-customers-query.dto';

export interface PaginatedCustomers {
  data: Customer[];
  total: number;
  page: number;
  limit: number;
}

@Injectable()
export class CustomersService {
  constructor(
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
  ) {}

  async create(dto: CreateCustomerDto): Promise<Customer> {
    if (dto.email) {
      const existing = await this.customerRepository.findOne({ where: { email: dto.email } });
      if (existing) {
        throw new ConflictException('A customer with this email already exists');
      }
    }

    const customer = this.customerRepository.create(dto);
    return this.customerRepository.save(customer);
  }

  async findAll(query: ListCustomersQueryDto): Promise<PaginatedCustomers> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.customerRepository.createQueryBuilder('customer');

    if (query.search) {
      // Prefix match ONLY ('term%'), never '%term%' — a leading wildcard
      // can't use the lastName/email indexes and forces a full table
      // scan as the table grows. This intentionally limits search to
      // "starts with", per the scaling requirement for this task.
      qb.where('customer.lastName ILIKE :search', { search: `${query.search}%` }).orWhere(
        'customer.email ILIKE :search',
        { search: `${query.search}%` },
      );
    }

    qb.orderBy('customer.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  async findById(id: string): Promise<Customer> {
    const customer = await this.customerRepository.findOne({ where: { id } });
    if (!customer) {
      throw new NotFoundException('Customer not found');
    }
    return customer;
  }

  async update(id: string, dto: UpdateCustomerDto): Promise<Customer> {
    const customer = await this.findById(id);

    if (dto.email && dto.email !== customer.email) {
      const existing = await this.customerRepository.findOne({ where: { email: dto.email } });
      if (existing) {
        throw new ConflictException('A customer with this email already exists');
      }
    }

    Object.assign(customer, dto);
    return this.customerRepository.save(customer);
  }

  // Real delete: nothing references Customer yet (Order doesn't exist in
  // this codebase). Flagged explicitly in the task report (item 9) rather
  // than assumed — once Order.customerId exists with onDelete: 'RESTRICT',
  // this becomes automatically protected, same precedent as Category ->
  // Product in this project. No new status/entity invented here.
  async delete(id: string): Promise<void> {
    const customer = await this.findById(id);
    await this.customerRepository.remove(customer);
  }
}
