import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Category } from './entities/category.entity';
import { CategoriesService } from './categories.service';
import { CategoriesController } from './categories.controller';
import { Product } from '../products/entities/product.entity';
@Module({
  imports: [TypeOrmModule.forFeature([Category, Product])],
  controllers: [CategoriesController],
  providers: [CategoriesService],
  // Exported so ProductsModule (Step 2) can inject CategoriesService to
  // validate a given categoryId exists before creating/updating a Product.
  exports: [CategoriesService],
})
export class CategoriesModule {}
