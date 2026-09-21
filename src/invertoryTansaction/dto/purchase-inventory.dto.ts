import { IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class PurchaseInventoryDto {
  @IsUUID()
  inventoryId: string;

  @IsInt()
  @Min(1)
  quantity: number;

  @IsOptional()
  @IsString()
  reason?: string;
}