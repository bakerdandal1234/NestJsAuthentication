import 'dotenv/config';
import { DataSource } from 'typeorm';
import { databaseOptions } from './database-options';
export const AppDataSource = new DataSource({
  ...databaseOptions(process.env),
  migrations: ['src/migrations/*.ts'],
});
