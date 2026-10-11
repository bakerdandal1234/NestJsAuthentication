import type { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { databaseOptions } from './database-options';

export default function typeormConfig(): TypeOrmModuleOptions {
  return databaseOptions(process.env);
}
