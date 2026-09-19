import { Module } from '@nestjs/common';
import { AdminCrmGuard } from '../common/admin-crm.guard';
import { AdminController } from './admin.controller';
import { AdminStatsService } from './admin.service';

@Module({
  controllers: [AdminController],
  providers: [AdminStatsService, AdminCrmGuard],
  exports: [AdminStatsService],
})
export class AdminModule {}
