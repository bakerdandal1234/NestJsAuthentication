import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';

import {
  InventoryTransaction,
  InventoryTransactionType,
} from './entity/InventoryTransaction.entity';
import { Inventory } from '../inventory/entities/inventory.entity';
import { PurchaseInventoryDto } from './dto/purchase-inventory.dto';
import { AdjustInventoryDto } from './dto/adjust-inventory.dto';

@Injectable()
export class InventoryTransactionsService {
  constructor(
    @InjectRepository(InventoryTransaction)
    private readonly transactionRepository: Repository<InventoryTransaction>,

    @InjectRepository(Inventory)
    private readonly inventoryRepository: Repository<Inventory>,

    private readonly dataSource: DataSource,
  ) {}

  async purchase(
    dto: PurchaseInventoryDto,
    userId: string,
  ): Promise<InventoryTransaction> {
    return this.dataSource.transaction(async (manager) => {
      const inventory = await manager
        .getRepository(Inventory)
        .createQueryBuilder('inventory')
        .setLock('pessimistic_write')
        .where('inventory.id = :id', { id: dto.inventoryId })
        .getOne();

      if (!inventory) {
        throw new NotFoundException('Inventory not found');
      }

      inventory.quantity += dto.quantity;

      await manager.getRepository(Inventory).save(inventory);

      const transaction = manager
        .getRepository(InventoryTransaction)
        .create({
          inventoryId: inventory.id,
          type: InventoryTransactionType.PURCHASE,
          quantity: dto.quantity,
          reason: dto.reason ?? null,
          referenceId: null,
          createdByUserId: userId,
        });

      return manager
        .getRepository(InventoryTransaction)
        .save(transaction);
    });
  }

  async adjust(
    dto: AdjustInventoryDto,
    userId: string,
  ): Promise<InventoryTransaction> {
    return this.dataSource.transaction(async (manager) => {
      const inventory = await manager
        .getRepository(Inventory)
        .createQueryBuilder('inventory')
        .setLock('pessimistic_write')
        .where('inventory.id = :id', { id: dto.inventoryId })
        .getOne();

      if (!inventory) {
        throw new NotFoundException('Inventory not found');
      }

      const isIncrease =
        dto.type === InventoryTransactionType.ADJUSTMENT_IN;

      const isDecrease =
        dto.type === InventoryTransactionType.ADJUSTMENT_OUT;

      if (!isIncrease && !isDecrease) {
        throw new BadRequestException(
          'Invalid adjustment transaction type',
        );
      }

      if (isDecrease && inventory.quantity < dto.quantity) {
        throw new BadRequestException('Insufficient inventory');
      }

      inventory.quantity += isIncrease
        ? dto.quantity
        : -dto.quantity;

      await manager.getRepository(Inventory).save(inventory);

      const transaction = manager
        .getRepository(InventoryTransaction)
        .create({
          inventoryId: inventory.id,
          type: dto.type,
          quantity: dto.quantity,
          reason: dto.reason,
          referenceId: null,
          createdByUserId: userId,
        });

      return manager
        .getRepository(InventoryTransaction)
        .save(transaction);
    });
  }

  async findByInventory(
    inventoryId: string,
  ): Promise<InventoryTransaction[]> {
    const inventory = await this.inventoryRepository.findOne({
      where: { id: inventoryId },
    });

    if (!inventory) {
      throw new NotFoundException('Inventory not found');
    }

    return this.transactionRepository.find({
      where: { inventoryId },
      order: {
        createdAt: 'DESC',
      },
    });
  }

  async findById(id: string): Promise<InventoryTransaction> {
    const transaction = await this.transactionRepository.findOne({
      where: { id },
    });

    if (!transaction) {
      throw new NotFoundException('Inventory transaction not found');
    }

    return transaction;
  }
}