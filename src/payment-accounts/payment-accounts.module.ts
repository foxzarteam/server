import { Module } from '@nestjs/common';
import { PaymentAccountsService } from './payment-accounts.service';

@Module({
  providers: [PaymentAccountsService],
  exports: [PaymentAccountsService],
})
export class PaymentAccountsModule {}
