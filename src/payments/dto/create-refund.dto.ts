import { IsString, IsUUID, Length } from 'class-validator';

export class CreateRefundDto {
  @IsUUID()
  paymentId: string;

  @IsString()
  @Length(1, 255)
  idempotencyKey: string;

  @IsString()
  @Length(1, 500)
  reason: string;
}