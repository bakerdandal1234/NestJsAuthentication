import { IsEmail, IsString, MinLength, MaxLength, Matches, IsNotEmpty } from 'class-validator';
import { MaxBcryptBytes } from '../../auth/password-limits';
const PASSWORD_RULE =
  /((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/;

const PASSWORD_MESSAGE =
  'Password must contain at least 8 characters, an uppercase letter, a lowercase letter, and a number or symbol.';
export class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8, { message: PASSWORD_MESSAGE })
  @MaxBcryptBytes()
  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  password: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  lastName?: string;
}
