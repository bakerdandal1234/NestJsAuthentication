import { IsEmail, IsString, MinLength, MaxLength, Matches, IsNotEmpty } from 'class-validator';
import { MaxBcryptBytes } from '../../auth/password-limits';

export class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  @MaxBcryptBytes()
  @Matches(/((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/, {
    message:
      'Password must contain at least one uppercase letter, one lowercase letter, and one number or special character',
  })
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
