import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateRoleDto {
  // Normalized so it always matches what RolesGuard compares against
  // (case/whitespace-insensitive), and so two roles can't be created that
  // only differ by casing (e.g. "Admin" vs "admin").
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase().trim() : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}