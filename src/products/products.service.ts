import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ImgbbService } from '../image-hosting/imgbb.service';
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
    private readonly imgbbService: ImgbbService,
  ) { }


  async uploadImage(
    productId: string,
    file: Express.Multer.File,
  ): Promise<Product> {
    const product = await this.findById(productId);

    const imageUrl = await this.imgbbService.uploadImage(
      file.buffer,
    );

    product.imageUrl = imageUrl;

    return this.productRepository.save(product);
  }
  


  
  async create(dto: CreateProductDto): Promise<Product> {
    const existingProduct = await this.productRepository.findOne({
      where: { sku: dto.sku },
    });

    if (existingProduct) {
      throw new ConflictException(
        'A product with this SKU already exists',
      );
    }

    await this.categoriesService.findById(dto.categoryId);

    // Product and Inventory must be created atomically.
    return this.dataSource.transaction(async (manager) => {
      const productRepository =
        manager.withRepository(this.productRepository);

      const product = productRepository.create(dto);
      const savedProduct = await productRepository.save(product);

      await this.inventoryService.createForProduct(
        savedProduct.id,
        manager,
      );

      return savedProduct;
    });
  }

  async findAll(): Promise<Product[]> {
    return this.productRepository.find({
      order: { name: 'ASC' },relations:['category']
    });
  }

  async findById(id: string): Promise<Product> {
    const product = await this.productRepository.findOne({
      where: { id },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return product;
  }

  async update(
    id: string,
    dto: UpdateProductDto,
  ): Promise<Product> {
    const product = await this.findById(id);

    if (dto.sku && dto.sku !== product.sku) {
      const existingProduct = await this.productRepository.findOne({
        where: { sku: dto.sku },
      });

      if (existingProduct) {
        throw new ConflictException(
          'A product with this SKU already exists',
        );
      }
    }

    if (
      dto.categoryId &&
      dto.categoryId !== product.categoryId
    ) {
      await this.categoriesService.findById(dto.categoryId);
    }

    const finalPrice = dto.price ?? product.price;
    const finalCostPrice =
      dto.costPrice ?? product.costPrice;

    if (finalPrice <= finalCostPrice) {
      throw new BadRequestException(
        'price must be greater than costPrice',
      );
    }

    Object.assign(product, dto);

    return this.productRepository.save(product);
  }
}