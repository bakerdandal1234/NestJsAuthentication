import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { InventoryTransactionType } from '../../invertoryTansaction/entity/InventoryTransaction.entity';

export class CreateInventoryTransactionDto {
  @IsUUID()
  inventoryId: string;

  @IsEnum(InventoryTransactionType)
  type: InventoryTransactionType;

  @IsInt()
  @Min(1)
  quantity: number;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsUUID()
  referenceId?: string;
}