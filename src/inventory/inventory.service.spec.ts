import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { InventoryService } from './inventory.service';
import { Inventory } from './entities/inventory.entity';
import { UpdateInventoryDto } from './dto/update-inventory.dto';

interface MockInventoryRepository {
  findOne: jest.Mock<Promise<Inventory | null>, [unknown]>;
  findAndCount: jest.Mock<Promise<[Inventory[], number]>, [unknown]>;
  save: jest.Mock<Promise<Inventory>, [Inventory]>;
}

function createMockRepository(): MockInventoryRepository {
  return {
    findOne: jest.fn(),
    findAndCount: jest.fn(),
    save: jest.fn(),
  };
}

function makeInventory(overrides: Partial<Inventory> = {}): Inventory {
  return {
    id: 'inv-1',
    productId: 'prod-1',
    quantity: 5,
    minimumStock: 2,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Inventory;
}

describe('InventoryService', () => {
  let service: InventoryService;
  let inventoryRepository: MockInventoryRepository;

  beforeEach(async () => {
    inventoryRepository = createMockRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: getRepositoryToken(Inventory), useValue: inventoryRepository },
      ],
    }).compile();

    service = module.get(InventoryService);
  });

  describe('findById', () => {
    it('returns the inventory record when found', async () => {
      const inventory = makeInventory();
      inventoryRepository.findOne.mockResolvedValue(inventory);

      await expect(service.findById('inv-1')).resolves.toEqual(inventory);
      expect(inventoryRepository.findOne).toHaveBeenCalledWith({ where: { id: 'inv-1' } });
    });

    it('throws NotFoundException when missing', async () => {
      inventoryRepository.findOne.mockResolvedValue(null);

      await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findByProductId', () => {
    it('returns the inventory record when found', async () => {
      const inventory = makeInventory();
      inventoryRepository.findOne.mockResolvedValue(inventory);

      await expect(service.findByProductId('prod-1')).resolves.toEqual(inventory);
      expect(inventoryRepository.findOne).toHaveBeenCalledWith({ where: { productId: 'prod-1' } });
    });

    it('throws NotFoundException when the product has no inventory record', async () => {
      inventoryRepository.findOne.mockResolvedValue(null);

      await expect(service.findByProductId('missing-product')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findAll', () => {
    it('paginates using the provided page/limit', async () => {
      const data = [makeInventory()];
      inventoryRepository.findAndCount.mockResolvedValue([data, 1]);

      const result = await service.findAll({ page: 2, limit: 10 });

      expect(inventoryRepository.findAndCount).toHaveBeenCalledWith({
        order: { createdAt: 'DESC' },
        skip: 10,
        take: 10,
      });
      expect(result).toEqual({ data, total: 1, page: 2, limit: 10 });
    });

    it('defaults to page 1 / limit 20 when not provided', async () => {
      inventoryRepository.findAndCount.mockResolvedValue([[], 0]);

      const result = await service.findAll({});

      expect(inventoryRepository.findAndCount).toHaveBeenCalledWith({
        order: { createdAt: 'DESC' },
        skip: 0,
        take: 20,
      });
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });
  });

  describe('updateMinimumStock', () => {
    it('updates and saves minimumStock', async () => {
      const inventory = makeInventory();
      inventoryRepository.findOne.mockResolvedValue(inventory);
      inventoryRepository.save.mockImplementation((entity) => Promise.resolve(entity));

      const dto: UpdateInventoryDto = { minimumStock: 7 };
      const result = await service.updateMinimumStock('inv-1', dto);

      expect(result.minimumStock).toBe(7);
      expect(inventoryRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ minimumStock: 7 }),
      );
    });

    it('throws NotFoundException when the inventory record is missing', async () => {
      inventoryRepository.findOne.mockResolvedValue(null);

      await expect(service.updateMinimumStock('missing', { minimumStock: 1 })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // DTO-level validation, tested directly against class-validator rather
  // than through HTTP, since this project has no e2e test harness yet.
  describe('UpdateInventoryDto validation', () => {
    it('rejects a negative minimumStock', async () => {
      const dto = plainToInstance(UpdateInventoryDto, { minimumStock: -1 });
      const errors = await validate(dto);

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].constraints).toHaveProperty('min');
    });

    it('rejects a non-integer minimumStock', async () => {
      const dto = plainToInstance(UpdateInventoryDto, { minimumStock: 1.5 });
      const errors = await validate(dto);

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].constraints).toHaveProperty('isInt');
    });

    it('accepts a valid minimumStock', async () => {
      const dto = plainToInstance(UpdateInventoryDto, { minimumStock: 0 });
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
    });
  });
});
