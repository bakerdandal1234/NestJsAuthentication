import { BadRequestException } from '@nestjs/common';

export function oauthProviderId(identifier: unknown): string {
  if (typeof identifier !== 'string' || identifier.trim().length === 0) {
    throw new BadRequestException(
      'OAuth provider did not provide a valid user identifier',
    );
  }
  return identifier;
}
