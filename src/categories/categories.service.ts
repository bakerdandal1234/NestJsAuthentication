import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Category } from './entities/category.entity';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { Product } from '../products/entities/product.entity';

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @InjectRepository(Product)
    private readonly productRepository: Repository<Product>,
  ) {}

  async create(dto: CreateCategoryDto): Promise<Category> {
    const existing = await this.categoryRepository.findOne({ where: { name: dto.name } });
    if (existing) {
      throw new ConflictException('Category already exists');
    }

    const category = this.categoryRepository.create(dto);
    return this.categoryRepository.save(category);
  }

  async findAll(): Promise<Category[]> {
    return this.categoryRepository.find({ order: { name: 'ASC' } });
  }

  async findById(id: string): Promise<Category> {
    const category = await this.categoryRepository.findOne({ where: { id } });
    if (!category) {
      throw new NotFoundException('Category not found');
    }
    return category;
  }

  async update(id: string, dto: UpdateCategoryDto): Promise<Category> {
    const category = await this.findById(id);

    if (dto.name && dto.name !== category.name) {
      const existing = await this.categoryRepository.findOne({ where: { name: dto.name } });
      if (existing) {
        throw new ConflictException('Category already exists');
      }
    }

    Object.assign(category, dto);
    return this.categoryRepository.save(category);
  }

  // Blocked at the application level (clear 409 message) AND at the DB
  // level (Product.category has onDelete: 'RESTRICT') -- the explicit
  // check below gives a friendly error instead of a raw FK-violation
  // bubbling up from Postgres.
  async delete(id: string): Promise<void> {
    const category = await this.findById(id);

    const productExists = await this.productRepository.exists({
      where: {
        categoryId: id,
      },
    });

    if (productExists) {
      throw new ConflictException('Cannot delete category with products');
    }

    await this.categoryRepository.remove(category);
  }
}
