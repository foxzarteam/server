import { Module } from '@nestjs/common';
import { AdminInternalGuard } from '../common/admin-internal.guard';
import { MobileAccessGuard } from '../common/mobile-access.guard';
import { OtpModule } from '../otp/otp.module';
import { UsersModule } from '../users/users.module';
import { PanAuditService } from '../security/pan-audit.service';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

@Module({
  imports: [OtpModule, UsersModule],
  controllers: [LeadsController],
  providers: [
    LeadsService,
    PanAuditService,
    AdminInternalGuard,
    MobileAccessGuard,
  ],
  exports: [LeadsService],
})
export class LeadsModule {}
