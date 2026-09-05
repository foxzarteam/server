import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { TABLE_WALLET, getCurrentIsoTime } from '../common/constants';
import { SUPABASE_CLIENT } from '../config/supabase';

export type WalletRow = {
  id: string;
  user_id: string;
  earning: number;
  redeem: number;
  balance: number;
  currency: string;
  created_at?: string;
  updated_at?: string;
};

@Injectable()
export class WalletService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  private get table() {
    return this.supabase.from(TABLE_WALLET);
  }

  private toWallet(row: Record<string, unknown> | null): WalletRow | null {
    if (!row?.user_id) return null;
    const n = (v: unknown) => {
      const x = Number(v);
      return Number.isFinite(x) ? x : 0;
    };
    return {
      id: String(row.id ?? ''),
      user_id: String(row.user_id),
      earning: n(row.earning),
      redeem: n(row.redeem),
      balance: n(row.balance),
      currency: String(row.currency ?? 'INR') || 'INR',
      ...(row.created_at ? { created_at: String(row.created_at) } : {}),
      ...(row.updated_at ? { updated_at: String(row.updated_at) } : {}),
    };
  }

  async getByUserId(userId: string): Promise<WalletRow | null> {
    const uid = userId.trim();
    if (!uid) return null;
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
    return this.toWallet(data as Record<string, unknown> | null);
  }

  /** Fetch wallet; create INR zero row if missing (legacy users / missing trigger). */
  async getOrCreateByUserId(userId: string): Promise<WalletRow | null> {
    const uid = userId.trim();
    if (!uid) return null;

    const existing = await this.getByUserId(uid);
    if (existing) return existing;

    const now = getCurrentIsoTime();
    const { data, error } = await this.table
      .insert({
        user_id: uid,
        earning: 0,
        redeem: 0,
        balance: 0,
        currency: 'INR',
        created_at: now,
        updated_at: now,
      })
      .select('id, user_id, earning, redeem, balance, currency, created_at, updated_at')
      .single();

    if (error) {
      // Race: another request created the row
      const again = await this.getByUserId(uid);
      if (again) return again;
      if (process.env.NODE_ENV !== 'production') {
        console.error('WalletService.getOrCreateByUserId', error);
      }
      return null;
    }
    return this.toWallet(data as Record<string, unknown>);
  }
}
