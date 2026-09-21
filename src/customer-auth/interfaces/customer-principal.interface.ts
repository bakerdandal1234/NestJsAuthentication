export interface CustomerPrincipal {
  accountId: string;
  customerId: string;
  sessionId: string;
  email: string;
  isEmailVerified: boolean;
  isTwoFactorEnabled: boolean;
}