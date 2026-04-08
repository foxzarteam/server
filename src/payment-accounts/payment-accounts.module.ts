import { Module } from '@nestjs/common';
import { PaymentAccountsController } from './payment-accounts.controller';
import { PaymentAccountsService } from './payment-accounts.service';
import { SupabaseModule } from '../config/supabase.module';

@Module({
  imports: [SupabaseModule],
  controllers: [PaymentAccountsController],
  providers: [PaymentAccountsService],
})
export class PaymentAccountsModule {}
