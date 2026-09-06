import { IsString } from 'class-validator';

export class OAuthExchangeDto {
  @IsString()
  code: string;
}
