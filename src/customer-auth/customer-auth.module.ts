import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Customer } from '../customers/entities/customer.entity';
import { CustomerAccountsService } from './customer-accounts.service';
import { CustomerAuthController } from './customer-auth.controller';
import { CustomerAuthService } from './customer-auth.service';
import { CustomerCookiesService } from './customer-cookies.service';
import { CustomerExchangeService } from './customer-exchange.service';
import { CustomerFrontendService } from './customer-frontend.service';
import { CustomerOAuthStateService } from './customer-oauth-state.service';
import { CustomerSessionsService } from './customer-sessions.service';
import { CustomerTokensService } from './customer-tokens.service';
import { CustomerAccount } from './entities/customer-account.entity';
import { CustomerLoginHistory } from './entities/customer-login-history.entity';
import { CustomerSession } from './entities/customer-session.entity';
import { CustomerOAuthRedirectFilter } from './filters/customer-oauth-redirect.filter';
import { CustomerTwoFactorService } from './customer-two-factor.service';
import {
  CustomerGoogleCallbackGuard,
  CustomerGoogleStartGuard,
} from './guards/customer-google-auth.guard';
import { CustomerJwtAuthGuard } from './guards/customer-jwt-auth.guard';
import { CustomerGoogleStrategy } from './strategies/customer-google.strategy';
import { CustomerJwtStrategy } from './strategies/customer-jwt.strategy';

@Module({
  imports: [
    ConfigModule,
    PassportModule,
    // No global secret/expiry: every customer token is signed with its own
    // secret and options passed per call (see CustomerTokensService), which
    // is what keeps customer tokens unverifiable by the staff flow.
    JwtModule.register({}),
    TypeOrmModule.forFeature([
      CustomerAccount,
      CustomerSession,
      CustomerLoginHistory,
      Customer,
    ]),
  ],
  controllers: [CustomerAuthController],
  providers: [
    // Identity
    CustomerAccountsService,
    // Flow orchestration
    CustomerAuthService,
    CustomerTwoFactorService,
    // Single-responsibility collaborators
    CustomerCookiesService,
    CustomerExchangeService,
    CustomerFrontendService,
    CustomerOAuthStateService,
    CustomerSessionsService,
    CustomerTokensService,
    // Passport
    CustomerGoogleStrategy,
    CustomerJwtStrategy,
    CustomerGoogleStartGuard,
    CustomerGoogleCallbackGuard,
    CustomerJwtAuthGuard,
    // Route-scoped filter (listed here so it can be constructor-injected)
    CustomerOAuthRedirectFilter,
  ],
  exports: [CustomerJwtAuthGuard],
})
export class CustomerAuthModule {}
