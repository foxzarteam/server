import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { adminInternalKeyOk } from '../common/admin-internal';
import { TABLE_LEADS, TABLE_PARTNER, TABLE_USERS } from '../common/constants';
import { SUPABASE_CLIENT } from '../config/supabase';

import { AdminStatsService } from './admin.service';

@Controller('admin')
export class AdminController {
  constructor(private readonly adminStatsService: AdminStatsService) {}

  @Get('stats')
  @HttpCode(HttpStatus.OK)
  async getStats(@Headers('x-admin-internal-key') adminKey: string | undefined) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const data = await this.adminStatsService.getDashboardStats();
    return { success: true, data };
  }
}
