import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { AdminCrmGuard } from '../common/admin-crm.guard';
import { AdminStatsService } from './admin.service';

@Controller('admin')
export class AdminController {
  constructor(private readonly adminStatsService: AdminStatsService) {}

  @Get('stats')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async getStats() {
    const data = await this.adminStatsService.getDashboardStats();
    return { success: true, data };
  }
}
