import { Module } from '@nestjs/common';
import { OtpModule } from '../otp/otp.module';
import { UsersModule } from '../users/users.module';
import { PaymentAccountsController } from './payment-accounts.controller';
import { PaymentAccountsService } from './payment-accounts.service';

@Module({
  imports: [UsersModule, OtpModule],
  controllers: [PaymentAccountsController],
  providers: [PaymentAccountsService],
  exports: [PaymentAccountsService],
})
export class PaymentAccountsModule {}

export { PaymentAccountsService } from './payment-accounts.service';
export { PaymentAccountsController } from './payment-accounts.controller';
export {
  UpsertPaymentAccountDto,
} from './payment-accounts.dto';
