import { Module } from '@nestjs/common';
import { PartnerAccessGuard } from '../common/partner-access.guard';
import { LeadsModule } from '../leads/leads.module';
import { PaymentAccountsModule } from '../payment-accounts/payment-accounts.module';
import { UsersModule } from '../users/users.module';
import { WalletModule } from '../wallet/wallet.module';
import { AgentController } from './agent.controller';

@Module({
  imports: [UsersModule, LeadsModule, WalletModule, PaymentAccountsModule],
  controllers: [AgentController],
  providers: [PartnerAccessGuard],
})
export class AgentModule {}
