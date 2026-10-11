import { BadRequestException } from '@nestjs/common';
import { ValidateBy } from 'class-validator';
import { truncates } from 'bcryptjs';

const PASSWORD_BYTE_LIMIT_MESSAGE = 'Password must not exceed 72 bytes in UTF-8.';

function passwordFitsBcrypt(password: unknown): boolean {
  return typeof password === 'string' && !truncates(password);
}

export function MaxBcryptBytes(): PropertyDecorator {
  return ValidateBy({
    name: 'maxBcryptBytes',
    validator: {
      validate: passwordFitsBcrypt,
      defaultMessage: () => PASSWORD_BYTE_LIMIT_MESSAGE,
    },
  });
}

export function assertPasswordFitsBcrypt(password: string): void {
  if (!passwordFitsBcrypt(password)) {
    throw new BadRequestException(PASSWORD_BYTE_LIMIT_MESSAGE);
  }
}
