import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { parse as parseCookies } from 'cookie';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const configService = app.get(ConfigService);

  // Needed so `secure` cookies (see AuthService.getAuthCookieSettings()) are
  // detected correctly when this app sits behind a reverse proxy / load
  // balancer that terminates TLS in production (Express otherwise sees the
  // proxy's plain-HTTP connection and would treat every request as insecure).
  app.set('trust proxy', 1);

  app.use(helmet());

  // Minimal cookie parser: reads the `Cookie` header into `req.cookies`,
  // using the `cookie` package (already a transitive dependency of Express,
  // so no new package install is required). Only parsing is needed here —
  // writing cookies is done via Express's built-in `res.cookie()`.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.cookies = req.headers.cookie ? parseCookies(req.headers.cookie) : {};
    next();
  });

  app.enableCors({
    origin: configService.get<string>('FRONTEND_URL'),
    credentials: true,
  });

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip properties not defined in the DTO
      forbidNonWhitelisted: true, // reject requests with unknown properties
      transform: true, // auto-transform payloads to DTO instances
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const port = configService.get<number>('PORT') ?? 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Application is running on: http://localhost:${port}`);
}

bootstrap();
