import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsNumber,
  IsPositive,
  IsEnum,
  Validate,
} from 'class-validator';
import { ProductStatus } from '../entities/product.entity';
import { IsGreaterThan } from '../../common/validators/is-greater-than.validator';

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  @IsNotEmpty()
  sku: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  costPrice: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Validate(IsGreaterThan, ['costPrice'])
  price: number;

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @IsUUID()
  categoryId: string;
}