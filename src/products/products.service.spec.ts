import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, DeepPartial, EntityManager } from 'typeorm';

import { ProductsService } from './products.service';
import { Product } from './entities/product.entity';
import { CategoriesService } from '../categories/categories.service';
import { Category } from '../categories/entities/category.entity';
import { InventoryService } from '../inventory/inventory.service';
import { Inventory } from '../inventory/entities/inventory.entity';
import { CreateProductDto } from './dto/create-product.dto';

interface MockProductRepository {
  findOne: jest.Mock<Promise<Product | null>, [unknown]>;
  create: jest.Mock<Product, [DeepPartial<Product>]>;
  save: jest.Mock<Promise<Product>, [Product]>;
}

function createMockProductRepository(): MockProductRepository {
  return {
    findOne: jest.fn(),
    create: jest.fn((data) => data as Product),
    save: jest.fn(),
  };
}

// Only the new Product + Inventory atomic-creation integration is covered
// here. ProductsService's other pre-existing methods (findAll, findById,
// update) are unchanged by this task and are out of scope.
describe('ProductsService (Inventory integration)', () => {
  let service: ProductsService;
  let productRepository: MockProductRepository;
  let categoriesService: { findById: jest.Mock<Promise<Category>, [string]> };
  let inventoryService: {
    createForProduct: jest.Mock<Promise<Inventory>, [string, EntityManager]>;
  };
  let dataSource: {
    transaction: jest.Mock<Promise<Product>, [(manager: EntityManager) => Promise<Product>]>;
  };
  let mockManager: {
    withRepository: jest.Mock<MockProductRepository, [MockProductRepository]>;
  };

  const dto: CreateProductDto = {
    name: 'Widget',
    sku: 'WIDGET-1',
    costPrice: 5,
    price: 10,
    categoryId: 'cat-1',
  };

  beforeEach(async () => {
    productRepository = createMockProductRepository();
    productRepository.findOne.mockResolvedValue(null); // no existing SKU
    productRepository.save.mockImplementation((entity) =>
      Promise.resolve({ id: 'prod-1', ...entity }) as Promise<Product>,
    );

    categoriesService = { findById: jest.fn().mockResolvedValue({ id: 'cat-1' } as Category) };
    inventoryService = {
      createForProduct: jest.fn().mockResolvedValue({ id: 'inv-1' } as Inventory),
    };

    // withRepository(repo) just hands back the same mock, so assertions
    // made "inside" the transaction can be checked the normal way.
    mockManager = { withRepository: jest.fn((repo) => repo) };
    dataSource = {
      transaction: jest.fn((runInTransaction) =>
        runInTransaction(mockManager as unknown as EntityManager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: getRepositoryToken(Product), useValue: productRepository },
        { provide: CategoriesService, useValue: categoriesService },
        { provide: InventoryService, useValue: inventoryService },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(ProductsService);
  });

  it('creates the Product and its Inventory inside a single transaction', async () => {
    const result = await service.create(dto);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(mockManager.withRepository).toHaveBeenCalledWith(productRepository);
    expect(productRepository.save).toHaveBeenCalledTimes(1);
    expect(inventoryService.createForProduct).toHaveBeenCalledWith('prod-1', mockManager);
    expect(result).toEqual(expect.objectContaining({ id: 'prod-1' }));
  });

  it('rejects duplicate SKUs before opening a transaction', async () => {
    productRepository.findOne.mockResolvedValueOnce({ id: 'existing', sku: dto.sku } as Product);

    await expect(service.create(dto)).rejects.toThrow(ConflictException);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('propagates a failure from Inventory creation (rolls back in a real DB)', async () => {
    // This unit test mocks DataSource.transaction, so it can only verify
    // that a failure inside the transaction callback propagates out of
    // ProductsService.create() instead of being swallowed. Verifying an
    // actual Postgres ROLLBACK would require an integration test against
    // a live DataSource, which this project's current test setup (no
    // jest DB config, no test/ e2e harness) does not provide.
    inventoryService.createForProduct.mockRejectedValueOnce(new Error('inventory insert failed'));

    await expect(service.create(dto)).rejects.toThrow('inventory insert failed');
    expect(productRepository.save).toHaveBeenCalledTimes(1);
  });
});
