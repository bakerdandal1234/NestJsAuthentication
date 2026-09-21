import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { InventoryTransactionType } from '../entity/InventoryTransaction.entity';

export class AdjustInventoryDto {
  @IsUUID()
  inventoryId: string;

  @IsEnum(
    InventoryTransactionType,
    {
      message: 'type must be ADJUSTMENT_IN or ADJUSTMENT_OUT',
    },
  )
  type: InventoryTransactionType;

  @IsInt()
  @Min(1)
  quantity: number;

  @IsString()
  reason: string;
}