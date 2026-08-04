import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { TABLE_WALLET } from '../common/constants';
import { SUPABASE_CLIENT } from '../config/supabase';

@Injectable()
export class WalletService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  private get table() {
    return this.supabase.from(TABLE_WALLET);
  }

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
