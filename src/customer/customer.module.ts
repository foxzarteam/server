import { Module } from '@nestjs/common';
import { OtpModule } from '../otp/otp.module';
import { LeadsModule } from '../leads/leads.module';
import { CustomerController } from './customer.controller';
import { CustomerService } from './customer.service';

@Module({
  imports: [LeadsModule, OtpModule],
  controllers: [CustomerController],
  providers: [CustomerService],
  exports: [CustomerService],
})
export class CustomerModule {}

export { CustomerService } from './customer.service';
export { CustomerController } from './customer.controller';
export {
  CheckMobileDto,
  CustomerLoginDto,
  ApplicationsDto,
  UpdateProfileDto,
} from './customer.dto';
