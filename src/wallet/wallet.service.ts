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

/** Personal loan: 2% of lead amount. Insurance: flat ₹1000. */
export const LOAN_COMMISSION_RATE = 0.02;
export const INSURANCE_COMMISSION_FLAT = 1000;

function roundMoney(n: number): number {
  return Math.round(Math.max(0, n) * 100) / 100;
}

export function commissionForLead(lead: {
  category?: unknown;
  required_amount?: unknown;
}): number {
  const cat = String(lead.category ?? '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (cat === 'insurance') return INSURANCE_COMMISSION_FLAT;
  const amount = Number(lead.required_amount);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return roundMoney(amount * LOAN_COMMISSION_RATE);
}

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

  /**
   * Set partner earning to the sum of commissions from approved leads.
   * balance = earning − redeem (clamped ≥ 0).
   */
  async setEarningFromCommissions(
    userId: string,
    earningTotal: number,
  ): Promise<WalletRow | null> {
    const wallet = await this.getOrCreateByUserId(userId);
    if (!wallet?.id) return null;

    const earning = roundMoney(earningTotal);
    const redeem = roundMoney(wallet.redeem);
    const balance = roundMoney(Math.max(0, earning - redeem));

    if (
      wallet.earning === earning &&
      wallet.balance === balance &&
      wallet.redeem === redeem
    ) {
      return wallet;
    }

    const { data, error } = await this.table
      .update({
        earning,
        redeem,
        balance,
        updated_at: getCurrentIsoTime(),
      })
      .eq('id', wallet.id)
      .select('id, user_id, earning, redeem, balance, currency, created_at, updated_at')
      .single();

    if (error) {
      console.error('WalletService.setEarningFromCommissions', error);
      return null;
    }
    return this.toWallet(data as Record<string, unknown>);
  }
}
