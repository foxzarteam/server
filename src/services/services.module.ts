import { Module } from '@nestjs/common';
import { AdminCrmGuard, AdminOnlyGuard } from '../common/admin-crm.guard';
import { ServicesController } from './services.controller';
import { ServicesService } from './services.service';

@Module({
  controllers: [ServicesController],
  providers: [ServicesService, AdminCrmGuard, AdminOnlyGuard],
  exports: [ServicesService],
})
export class ServicesModule {}
