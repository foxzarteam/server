import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../config/supabase.config';
import { TABLE_WALLET } from '../common/constants';

@Injectable()
export class WalletService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  private get table() {
    return this.supabase.from(TABLE_WALLET);
  }

  /**
   * Get wallet row for user. Returns balance, earning, redeem, currency (and id, timestamps if needed).
   * Default wallet row is created by DB trigger on public.users INSERT.
   */
  async getByUserId(userId: string): Promise<Record<string, unknown> | null> {
    const uid = userId.trim();
    const { data, error } = await this.table
      .select('id, user_id, earning, redeem, balance, currency, created_at, updated_at')
      .eq('user_id', uid)
      .maybeSingle();

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('WalletService.getByUserId', error);
      }
      return null;
    }
    return data as Record<string, unknown> | null;
  }
}
