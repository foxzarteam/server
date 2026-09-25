import { Module } from '@nestjs/common';
import { AdminCrmGuard, AdminOnlyGuard, AdminPanelGuard } from '../common/admin-crm.guard';
import { OtpModule } from '../otp/otp.module';
import { ServicesModule } from '../services/services.module';
import { UsersModule } from '../users/users.module';
import { WalletModule } from '../wallet/wallet.module';
import { PanAuditService } from '../security/pan-audit.service';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

@Module({
  imports: [OtpModule, UsersModule, WalletModule, ServicesModule],
  controllers: [LeadsController],
  providers: [
    LeadsService,
    PanAuditService,
    AdminCrmGuard,
    AdminPanelGuard,
    AdminOnlyGuard,
  ],
  exports: [LeadsService],
})
export class LeadsModule {}
