import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsNumber,
  IsPositive,
  IsEnum,
} from 'class-validator';
import { ProductStatus } from '../entities/product.entity';

// price > costPrice is deliberately NOT enforced here (unlike
// CreateProductDto's @Validate(IsGreaterThan, ['costPrice'])) — a PATCH
// may send just one of the two fields, and a DTO-level validator has no
// way to compare against the value already stored in the DB. That
// invariant is enforced in ProductsService.update() instead, using both
// the existing entity and the incoming dto together.
export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  sku?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  costPrice?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  price?: number;

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @IsOptional()
  @IsUUID()
  categoryId?: string;
}
