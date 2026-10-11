import { IsEmail, IsString, IsOptional, Length } from 'class-validator';
import { MaxBcryptBytes } from '../password-limits';

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MaxBcryptBytes()
  password: string;

  @IsOptional()
  @IsString()
  @Length(6, 6)
  twoFactorCode?: string;
}
