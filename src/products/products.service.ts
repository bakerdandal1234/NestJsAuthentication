import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Product } from './entities/product.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { CategoriesService } from '../categories/categories.service';
import { InventoryService } from '../inventory/inventory.service';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
    private readonly categoriesService: CategoriesService,
    private readonly inventoryService: InventoryService,
    private readonly dataSource: DataSource,
  ) {}

  async create(dto: CreateProductDto): Promise<Product> {
    const existing = await this.productRepository.findOne({ where: { sku: dto.sku } });
    if (existing) {
      throw new ConflictException('A product with this SKU already exists');
    }

    // Throws NotFoundException if categoryId doesn't exist — checked here
    // for a clear error message, in addition to the DB-level FK.
    await this.categoriesService.findById(dto.categoryId);

    // Product 1 -> 1 Inventory (approved design): the two inserts must be
    // atomic. If either fails, neither should remain. A single DB
    // transaction is the correct, minimal tool for that — no queue/worker
    // needed. manager.withRepository() rebinds the existing repository to
    // this transaction's EntityManager so both writes commit/rollback
    // together.
    return this.dataSource.transaction(async (manager) => {
      const productRepo = manager.withRepository(this.productRepository);

      const product = productRepo.create(dto);
      const savedProduct = await productRepo.save(product);

      // quantity/minimumStock are hardcoded to 0 inside InventoryService —
      // no API client can set them at creation time.
      await this.inventoryService.createForProduct(savedProduct.id, manager);

      return savedProduct;
    });
  }

  async findAll(): Promise<Product[]> {
    return this.productRepository.find({ order: { name: 'ASC' } });
  }

  async findById(id: string): Promise<Product> {
    const product = await this.productRepository.findOne({ where: { id } });
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    return product;
  }

  async update(id: string, dto: UpdateProductDto): Promise<Product> {
    const product = await this.findById(id);

    if (dto.sku && dto.sku !== product.sku) {
      const existing = await this.productRepository.findOne({ where: { sku: dto.sku } });
      if (existing) {
        throw new ConflictException('A product with this SKU already exists');
      }
    }

    if (dto.categoryId && dto.categoryId !== product.categoryId) {
      await this.categoriesService.findById(dto.categoryId);
    }

    // price > costPrice invariant — enforced HERE, not on the DTO, since a
    // PATCH may only touch one of the two fields (see UpdateProductDto).
    const finalPrice = dto.price ?? product.price;
    const finalCostPrice = dto.costPrice ?? product.costPrice;
    if (finalPrice <= finalCostPrice) {
      throw new BadRequestException('price must be greater than costPrice');
    }

    Object.assign(product, dto);
    return this.productRepository.save(product);
  }

  // No delete() — applying the same "never hard-delete a Product" default
  // we used before (protects future Order history from dangling
  // references). Deactivate via update() with { status: 'INACTIVE' }
  // instead. Tell me if you actually want a real DELETE endpoint here.
}
