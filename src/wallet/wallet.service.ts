import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { TABLE_WALLET, getCurrentIsoTime } from '../common/constants';
import { SUPABASE_CLIENT } from '../config/supabase';
import { MSG_WALLET_SYNC_FAILED, WalletSyncError } from './wallet-sync';
import { leadLoanAmount } from './loan-amount';

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
  loan_amt?: unknown;
}): number {
  const cat = String(lead.category ?? '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (cat === 'insurance') return INSURANCE_COMMISSION_FLAT;
  const amount = leadLoanAmount(lead);
  if (amount <= 0) return 0;
  return roundMoney(amount * LOAN_COMMISSION_RATE);
}

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

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
   * Recompute this partner's earning under a DB advisory lock.
   * Throws WalletSyncError instead of returning null.
   */
  async reconcileByUserId(userId: string): Promise<WalletRow> {
    const uid = userId.trim();
    if (!uid) {
      throw new WalletSyncError(MSG_WALLET_SYNC_FAILED);
    }

    const { data, error } = await this.supabase.rpc('reconcile_partner_wallet', {
      p_user_id: uid,
    });

    if (error) {
      this.logger.error(`reconcile_partner_wallet failed user=${uid}: ${error.message}`);
      throw new WalletSyncError(MSG_WALLET_SYNC_FAILED);
    }

    const row = this.parseRpc(data);
    if (!row || row.ok !== true) {
      this.logger.error(`reconcile_partner_wallet unexpected payload user=${uid}`);
      throw new WalletSyncError(MSG_WALLET_SYNC_FAILED);
    }

    if (row.skipped) {
      const existing = await this.getOrCreateByUserId(uid);
      if (!existing) throw new WalletSyncError(MSG_WALLET_SYNC_FAILED);
      return existing;
    }

    return {
      id: '',
      user_id: uid,
      earning: roundMoney(Number(row.earning)),
      redeem: roundMoney(Number(row.redeem)),
      balance: roundMoney(Number(row.balance)),
      currency: 'INR',
    };
  }

  /**
   * Lock-and-recompute from approved leads. The passed total is ignored so a
   * stale in-process sum cannot overwrite a concurrent approval.
   */
  async setEarningFromCommissions(
    userId: string,
    _earningTotal?: number,
  ): Promise<WalletRow> {
    return this.reconcileByUserId(userId);
  }

  private parseRpc(data: unknown): {
    ok?: boolean;
    skipped?: boolean;
    earning?: unknown;
    redeem?: unknown;
    balance?: unknown;
  } | null {
    if (data == null) return null;
    if (typeof data === 'string') {
      try {
        return JSON.parse(data) as {
          ok?: boolean;
          skipped?: boolean;
          earning?: unknown;
          redeem?: unknown;
          balance?: unknown;
        };
      } catch {
        return null;
      }
    }
    if (typeof data === 'object') {
      return data as {
        ok?: boolean;
        skipped?: boolean;
        earning?: unknown;
        redeem?: unknown;
        balance?: unknown;
      };
    }
    return null;
  }
}
