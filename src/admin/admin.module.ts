import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminStatsService } from './admin.service';

@Module({
  controllers: [AdminController],
  providers: [AdminStatsService],
  exports: [AdminStatsService],
})
export class AdminModule {}

export { AdminStatsService } from './admin.service';
export { AdminController } from './admin.controller';
