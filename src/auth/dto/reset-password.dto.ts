import { IsString, MinLength, Matches } from 'class-validator';
import { MaxBcryptBytes } from '../password-limits';

export class ResetPasswordDto {
  @IsString()
  token: string;

  @IsString()
  @MinLength(8)
  @MaxBcryptBytes()
  @Matches(/((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/, {
    message:
      'Password must contain at least one uppercase letter, one lowercase letter, and one number or special character',
  })
  newPassword: string;
}
