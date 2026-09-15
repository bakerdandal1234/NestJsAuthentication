import { IsInt, Min } from 'class-validator';

// Only `minimumStock` is editable through the public API. `quantity` is
// intentionally absent from this DTO -- normal clients can never set it
// directly (see InventoryController); it will later be changed only
// through centralized InventoryTransaction stock-movement logic.
export class UpdateInventoryDto {
  @IsInt()
  @Min(0)
  minimumStock: number;
}
