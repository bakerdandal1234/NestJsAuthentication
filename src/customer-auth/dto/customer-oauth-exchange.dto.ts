import { IsString, Matches } from 'class-validator';

import { CUSTOMER_EXCHANGE_CODE_PATTERN } from '../customer-auth.constants';

export class CustomerOAuthExchangeDto {
  /**
   * `<sessionId uuid>.<64 hex>` — the half of the handoff that travels in
   * the redirect URL. The other half (the binding) is read from an httpOnly
   * cookie and never accepted from the body.
   */
  @IsString()
  @Matches(CUSTOMER_EXCHANGE_CODE_PATTERN)
  code: string;
}
