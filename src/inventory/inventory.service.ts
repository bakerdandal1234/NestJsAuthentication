import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { Inventory } from './entities/inventory.entity';
import { UpdateInventoryDto } from './dto/update-inventory.dto';
import { ListInventoryQueryDto } from './dto/list-inventory-query.dto';

export interface PaginatedInventory {
  data: Inventory[];
  total: number;
  page: number;
  limit: number;
}

@Injectable()
export class InventoryService {
  constructor(
    @InjectRepository(Inventory)
    private readonly inventoryRepository: Repository<Inventory>,
  ) {}

  // Called ONLY from ProductsService.create(), inside the same DB
  // transaction (the `manager` passed in is the transactional
  // EntityManager from that transaction, via manager.withRepository() --
  // see ProductsService) so that Product + Inventory creation is atomic.
  // Never exposed through InventoryController: this is why quantity and
  // minimumStock are hardcoded to 0 here rather than accepted as
  // parameters -- normal API clients cannot set them at creation time.
  async createForProduct(productId: string, manager: EntityManager): Promise<Inventory> {
    const repo = manager.withRepository(this.inventoryRepository);
    const inventory = repo.create({ productId, quantity: 0, minimumStock: 0 });
    return repo.save(inventory);
  }

  async findById(id: string): Promise<Inventory> {
    const inventory = await this.inventoryRepository.findOne({ where: { id } });
    if (!inventory) {
      throw new NotFoundException('Inventory not found');
    }
    return inventory;
  }

  // Every Product has exactly one Inventory (enforced atomically at
  // creation time), so a miss here in practice means productId doesn't
  // exist. We look up Inventory directly rather than going through
  // ProductsService first, to avoid a circular module dependency
  // (ProductsModule already depends on InventoryModule for atomic
  // creation -- see ProductsService).
  async findByProductId(productId: string): Promise<Inventory> {
    const inventory = await this.inventoryRepository.findOne({ where: { productId } });
    if (!inventory) {
      throw new NotFoundException('Inventory not found for this product');
    }
    return inventory;
  }

  async findAll(query: ListInventoryQueryDto): Promise<PaginatedInventory> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [data, total] = await this.inventoryRepository.findAndCount({
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { data, total, page, limit };
  }

  // Only minimumStock is writable through this path. quantity is
  // deliberately untouched -- it will later be changed only through
  // centralized InventoryTransaction stock-movement logic (not part of
  // this task).
  async updateMinimumStock(id: string, dto: UpdateInventoryDto): Promise<Inventory> {
    const inventory = await this.findById(id);
    inventory.minimumStock = dto.minimumStock;
    return this.inventoryRepository.save(inventory);
  }

  // No delete() -- Inventory has no independent public lifecycle (see
  // approved design). It lives and dies with its Product at the DB level
  // (Inventory.product has onDelete: 'CASCADE'), and there is currently
  // no Product delete endpoint at all.
}
