import { Module } from '@nestjs/common';
import { AdminCrmGuard, AdminOnlyGuard, AdminPanelGuard } from '../common/admin-crm.guard';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, AdminCrmGuard, AdminOnlyGuard, AdminPanelGuard],
  exports: [UsersService],
})
export class UsersModule {}
