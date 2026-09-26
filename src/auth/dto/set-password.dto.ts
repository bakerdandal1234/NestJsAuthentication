import {
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const PASSWORD_RULE =
  /((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/;

const PASSWORD_MESSAGE =
  'Password must be 8-128 characters and contain an uppercase letter, a lowercase letter, and a number or symbol.';

/**
 * Used by POST /auth/set-password — unlike ChangePasswordDto, there is no
 * currentPassword field, because this route is only for accounts that
 * don't have one yet (OAuth-only accounts). See AuthService.setPassword().
 */
export class SetPasswordDto {
  @IsString()
  @MinLength(8, { message: PASSWORD_MESSAGE })
  @MaxLength(128, { message: PASSWORD_MESSAGE })
  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  newPassword: string;
}
