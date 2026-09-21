import { IsUUID, IsString, Length } from 'class-validator';

export class CreatePaymentDto {
  @IsUUID()
  orderId: string;

  @IsString()
  @Length(1, 255)
  idempotencyKey: string;
}