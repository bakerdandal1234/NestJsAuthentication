import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdatePermissionDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  action?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  resource: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}