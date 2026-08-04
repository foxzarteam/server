import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { TABLE_LEADS, TABLE_PARTNER, TABLE_USERS } from '../common/constants';
import { SUPABASE_CLIENT } from '../config/supabase';
import type { DashboardStats } from './admin.types';

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
