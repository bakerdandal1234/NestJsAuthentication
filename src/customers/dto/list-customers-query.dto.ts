import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ListCustomersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  // Prefix-only search term (see CustomersService.findAll) — never used
  // as a leading-wildcard '%term%' match.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
