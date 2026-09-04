import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import typeormConfig from './config/typeorm.config';
import { validate } from './config/env.validation';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { MailModule } from './mail/mail.module';
import { SessionsModule } from './sessions/sessions.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthorizationModule } from './authorization/authorization.module';
import { PermissionsGuard } from './common/guards/permissions.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
      load: [typeormConfig],
    }),
    TypeOrmModule.forRootAsync({
      useFactory: typeormConfig,
    }),
    ThrottlerModule.forRoot({
      throttlers: [
        {
          ttl: 60_000, // 1 minute
          limit: 60, // 60 requests per minute per IP, by default
        },
      ],
    }),
    AuthModule,
    UsersModule,
    MailModule,
    SessionsModule,
    AuthorizationModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Global rate limiting on every route.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Global JWT auth: every route requires a valid token unless @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Global RBAC: enforces @Roles(...) where present.
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // Normalizes all error responses.
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
