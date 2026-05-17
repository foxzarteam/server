import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { adminInternalKeyOk } from '../common/admin-internal';
import { TABLE_LEADS, TABLE_PARTNER, TABLE_USERS } from '../common/constants';
import { SUPABASE_CLIENT } from '../config/supabase';

export type DashboardStats = {
  totalLeads: number;
  totalAgents: number;
  totalPartners: number;
};

@Injectable()
export class AdminStatsService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  async getDashboardStats(): Promise<DashboardStats> {
    const [leadsRes, usersRes, partnersRes] = await Promise.all([
      this.supabase.from(TABLE_LEADS).select('*', { count: 'exact', head: true }),
      this.supabase.from(TABLE_USERS).select('*', { count: 'exact', head: true }),
      this.supabase.from(TABLE_PARTNER).select('*', { count: 'exact', head: true }),
    ]);

    if (leadsRes.error && process.env.NODE_ENV !== 'production') {
      console.error('AdminStatsService.getDashboardStats leads', leadsRes.error);
    }
    if (usersRes.error && process.env.NODE_ENV !== 'production') {
      console.error('AdminStatsService.getDashboardStats users', usersRes.error);
    }
    if (partnersRes.error && process.env.NODE_ENV !== 'production') {
      console.error('AdminStatsService.getDashboardStats partners', partnersRes.error);
    }

    return {
      totalLeads: leadsRes.count ?? 0,
      totalAgents: usersRes.count ?? 0,
      totalPartners: partnersRes.count ?? 0,
    };
  }
}

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

@Module({
  controllers: [AdminController],
  providers: [AdminStatsService],
})
export class AdminModule {}
