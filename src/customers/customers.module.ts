import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Customer } from './entities/customer.entity';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Customer])],
  controllers: [CustomersController],
  providers: [CustomersService],
  // Exported so a future OrdersModule can inject CustomersService to
  // validate a given customerId exists before attaching it to an Order.
  exports: [CustomersService],
})
export class CustomersModule {}
