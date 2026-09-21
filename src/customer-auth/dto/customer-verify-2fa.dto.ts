import { IsString, Matches } from 'class-validator';

export class CustomerVerify2faDto {
  /** A TOTP code: exactly six digits, nothing else. */
  @IsString()
  @Matches(/^\d{6}$/, {
    message: 'code must be a 6-digit authentication code',
  })
  code: string;
}
