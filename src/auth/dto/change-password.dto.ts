import {
  IsString,
  Matches,
  MinLength,
} from 'class-validator';
import { MaxBcryptBytes } from '../password-limits';

const PASSWORD_RULE =
  /((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/;

const PASSWORD_MESSAGE =
  'Password must contain at least 8 characters, an uppercase letter, a lowercase letter, and a number or symbol.';

export class ChangePasswordDto {
  @IsString()
  @MaxBcryptBytes()
  currentPassword: string;
  
  
  @IsString()
  @MinLength(8, { message: PASSWORD_MESSAGE })
  @MaxBcryptBytes()
  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  newPassword: string;
}
