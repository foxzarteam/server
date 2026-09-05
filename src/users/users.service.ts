import { randomBytes } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { hashMpin, mpinMatches, sanitizeUserPublic, storedMpinLooksBcrypt } from '../common/mpin';
import { toPublicErrorMessage } from '../common/public-error';
import { SUPABASE_CLIENT } from '../config/supabase';
import { MSG_USER_CREATE_FAILED, TABLE_USERS, TABLE_WALLET, getCurrentIsoTime } from '../common/constants';
import {
  AdminCreateUserDto,
  AdminUpdateUserDto,
  CreateUserDto,
  DEFAULT_USER_NAME,
  MPIN_LENGTH,
  UpdateLoginStatusDto,
  UpdateMpinDto,
  UpdateProfileDto,
  UpsertUserDto,
  VerifyMpinDto,
} from './users.dto';

@Injectable()
export class UsersService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  private get users() {
    return this.supabase.from(TABLE_USERS);
  }

  /** Ensure public.wallet row exists for this user (INR zeros if new). */
  private async ensureWalletRow(userId: string): Promise<void> {
    const uid = String(userId ?? '').trim();
    if (!uid) return;
    const { data } = await this.supabase
      .from(TABLE_WALLET)
      .select('id')
      .eq('user_id', uid)
      .maybeSingle();
    if (data) return;
    const now = getCurrentIsoTime();
    const { error } = await this.supabase.from(TABLE_WALLET).insert({
      user_id: uid,
      earning: 0,
      redeem: 0,
      balance: 0,
      currency: 'INR',
      created_at: now,
      updated_at: now,
    });
    if (error && process.env.NODE_ENV !== 'production') {
      console.error('UsersService.ensureWalletRow', error);
    }
  }

  private newReferralCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(8);
    let out = '';
    for (let i = 0; i < 8; i++) out += alphabet[bytes[i]! % alphabet.length];
    return out;
  }

  async generateUniqueReferralCode(): Promise<string> {
    for (let i = 0; i < 12; i++) {
      const code = this.newReferralCode();
      const { data } = await this.users.select('id').eq('referral_code', code).maybeSingle();
      if (!data) return code;
    }
    return this.newReferralCode() + this.newReferralCode().slice(0, 2);
  }

  async ensureReferralCode(row: Record<string, unknown>): Promise<Record<string, unknown>> {
    const existing = String(row.referral_code ?? '').trim();
    if (existing) return row;
    const id = String(row.id ?? '').trim();
    if (!id) return row;
    const code = await this.generateUniqueReferralCode();
    const { data, error } = await this.users
      .update({ referral_code: code, updated_at: getCurrentIsoTime() })
      .eq('id', id)
      .select()
      .single();
    if (error || !data) return { ...row, referral_code: code };
    return data as Record<string, unknown>;
  }

  async getIdByReferralCode(code: string | undefined): Promise<string | null> {
    const c = String(code ?? '').trim().toUpperCase();
    if (c.length < 6) return null;
    const { data, error } = await this.users.select('id').eq('referral_code', c).maybeSingle();
    if (error || !data) return null;
    const id = String((data as { id?: string }).id ?? '').trim();
    return id || null;
  }

  async loginAgent(mobile: string, mpin: string): Promise<Record<string, unknown> | null> {
    const user = await this.getByMobile(mobile);
    if (!user || user.is_active === false) return null;
    const ok = await this.verifyMpin(mobile, mpin);
    if (!ok) return null;
    const withCode = await this.ensureReferralCode(user);
    await this.ensureWalletRow(String(withCode.id ?? ''));
    await this.users
      .update({
        is_logged_in: true,
        last_login_at: getCurrentIsoTime(),
        updated_at: getCurrentIsoTime(),
      })
      .eq('id', String(withCode.id ?? ''));
    return sanitizeUserPublic(withCode);
  }

  async getByMobile(mobile: string): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.users
      .select()
      .eq('mobile_number', mobile)
      .maybeSingle();
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.getByMobile', error);
      }
      return null;
    }
    return data as Record<string, unknown> | null;
  }

  async getById(id: string): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.users.select().eq('id', id.trim()).maybeSingle();
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.getById', error);
      }
      return null;
    }
    return data as Record<string, unknown> | null;
  }

  async createForAdmin(
    dto: AdminCreateUserDto,
  ): Promise<{ ok: true; user: Record<string, unknown> } | { ok: false; duplicate: boolean; message: string }> {
    const { data: existing, error: lookupError } = await this.users
      .select('id')
      .eq('mobile_number', dto.mobileNumber)
      .maybeSingle();

    if (lookupError) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.createForAdmin lookup', lookupError);
      }
      return {
        ok: false,
        duplicate: false,
        message: toPublicErrorMessage(lookupError.message, 'Could not create account. Please try again.'),
      };
    }
    if (existing) {
      return {
        ok: false,
        duplicate: true,
        message: 'This phone number is already registered. Please log in.',
      };
    }

    const email = dto.email?.trim() || null;
    const [referralCode, mpinHash] = await Promise.all([
      this.generateUniqueReferralCode(),
      hashMpin(dto.mpin),
    ]);
    const { data, error } = await this.users
      .insert({
        mobile_number: dto.mobileNumber,
        user_name: dto.userName.trim(),
        email,
        mpin: mpinHash,
        referral_code: referralCode,
        is_active: true,
        is_logged_in: false,
      })
      .select()
      .single();
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.createForAdmin', error);
      }
      return {
        ok: false,
        duplicate: false,
        message: toPublicErrorMessage(error.message, 'Could not create account. Please try again.'),
      };
    }
    const user = sanitizeUserPublic(data as Record<string, unknown>);
    if (!user) {
      return { ok: false, duplicate: false, message: 'Could not create account. Please try again.' };
    }
    // Don't block register response on wallet row (created on first earnings fetch if missing).
    void this.ensureWalletRow(String(user.id ?? ''));
    return { ok: true, user };
  }

  async create(dto: CreateUserDto): Promise<Record<string, unknown> | null> {
    const existing = await this.getByMobile(dto.mobileNumber);
    if (existing) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('UsersService.create: duplicate mobileNumber', dto.mobileNumber);
      }
      return null;
    }

    const { data, error } = await this.users
      .insert({
        mobile_number: dto.mobileNumber,
        user_name: dto.userName ?? DEFAULT_USER_NAME,
        email: dto.email ?? null,
        is_active: true,
        is_logged_in: false,
      })
      .select()
      .single();
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.create', error);
      }
      return null;
    }
    return data as Record<string, unknown>;
  }

  async updateMpin(mobile: string, plainMpin: string): Promise<boolean> {
    const hashed = await hashMpin(plainMpin);
    const { error } = await this.users
      .update({
        mpin: hashed,
        updated_at: getCurrentIsoTime(),
      })
      .eq('mobile_number', mobile);
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.updateMpin', error);
      }
      return false;
    }
    return true;
  }

  async verifyMpin(mobile: string, plain: string): Promise<boolean> {
    const user = await this.getByMobile(mobile);
    if (!user) return false;
    const stored = String(user.mpin ?? '');
    if (!(await mpinMatches(plain, stored))) return false;
    if (stored && !storedMpinLooksBcrypt(stored)) {
      await this.updateMpin(mobile, plain);
    }
    return true;
  }

  async updateLoginStatus(mobile: string, dto: UpdateLoginStatusDto): Promise<boolean> {
    const now = getCurrentIsoTime();
    const payload: Record<string, unknown> = {
      is_logged_in: dto.isLoggedIn,
      updated_at: now,
    };
    if (dto.isLoggedIn) {
      payload.last_login_at = now;
    } else {
      payload.last_login_at = null;
    }
    const { error } = await this.users.update(payload).eq('mobile_number', mobile);
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.updateLoginStatus', error);
      }
      return false;
    }
    return true;
  }

  async updateProfile(mobile: string, dto: UpdateProfileDto): Promise<boolean> {
    const payload: Record<string, unknown> = {
      updated_at: getCurrentIsoTime(),
    };
    if (dto.userName != null) payload.user_name = dto.userName;
    if (dto.email != null) payload.email = dto.email;
    const { error } = await this.users.update(payload).eq('mobile_number', mobile);
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.updateProfile', error);
      }
      return false;
    }
    return true;
  }

  private async buildUpsertUpdatePayload(
    dto: UpsertUserDto,
  ): Promise<Record<string, unknown> | null> {
    const now = getCurrentIsoTime();
    const payload: Record<string, unknown> = { updated_at: now };
    if (dto.userName != null) payload.user_name = dto.userName;
    if (dto.email != null) payload.email = dto.email;
    if (dto.mpin != null) {
      const trimmed = dto.mpin.trim();
      if (trimmed.length !== MPIN_LENGTH) return null;
      payload.mpin = await hashMpin(trimmed);
    }
    if (dto.isLoggedIn != null) {
      payload.is_logged_in = dto.isLoggedIn;
      if (dto.isLoggedIn) payload.last_login_at = now;
    }
    return payload;
  }

  private async updateUser(mobile: string, payload: Record<string, unknown>): Promise<boolean> {
    const { error } = await this.users.update(payload).eq('mobile_number', mobile);
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.updateUser', error);
      }
      return false;
    }
    return true;
  }

  private async insertUser(dto: UpsertUserDto): Promise<boolean> {
    const now = getCurrentIsoTime();
    const insertPayload: Record<string, unknown> = {
      mobile_number: dto.mobileNumber,
      user_name: dto.userName ?? DEFAULT_USER_NAME,
      email: dto.email ?? null,
      mpin: dto.mpin != null ? await hashMpin(dto.mpin) : null,
      is_active: true,
      is_logged_in: dto.isLoggedIn ?? false,
    };
    if (dto.isLoggedIn) insertPayload.last_login_at = now;
    const { error } = await this.users.insert(insertPayload).select().single();
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.insertUser', error);
      }
      return false;
    }
    return true;
  }

  async upsert(dto: UpsertUserDto): Promise<boolean> {
    const existing = await this.getByMobile(dto.mobileNumber);

    if (existing) {
      const updatePayload = await this.buildUpsertUpdatePayload(dto);
      if (updatePayload == null) return false;
      return this.updateUser(dto.mobileNumber, updatePayload);
    }

    return this.insertUser(dto);
  }

  async getAll(): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.users.select().order('created_at', { ascending: false });

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.getAll', error);
      }
      return [];
    }

    return ((data as Record<string, unknown>[]) || []).map(
      (row) => sanitizeUserPublic(row) as Record<string, unknown>,
    );
  }

  async updateById(id: string, dto: AdminUpdateUserDto): Promise<Record<string, unknown> | null> {
    const now = getCurrentIsoTime();
    const payload: Record<string, unknown> = { updated_at: now };

    if (dto.userName != null) payload.user_name = dto.userName.trim();
    if (dto.email !== undefined) payload.email = dto.email?.trim() || null;
    if (dto.mobileNumber != null) payload.mobile_number = dto.mobileNumber.trim();
    if (dto.isActive != null) payload.is_active = dto.isActive;
    if (dto.isLoggedIn != null) {
      payload.is_logged_in = dto.isLoggedIn;
      if (dto.isLoggedIn) payload.last_login_at = now;
    }

    if (Object.keys(payload).length === 1) return null;

    const { data, error } = await this.users.update(payload).eq('id', id).select().single();

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.updateById', error);
      }
      return null;
    }

    return sanitizeUserPublic(data as Record<string, unknown>);
  }

  async deleteById(id: string): Promise<boolean> {
    const { error } = await this.users.delete().eq('id', id);

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.deleteById', error);
      }
      return false;
    }

    return true;
  }
}
