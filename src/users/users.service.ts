import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { hashMpin, mpinMatches, sanitizeUserPublic, storedMpinLooksBcrypt } from '../common/mpin';
import { SUPABASE_CLIENT } from '../config/supabase';
import { MSG_USER_CREATE_FAILED, TABLE_USERS, getCurrentIsoTime } from '../common/constants';
import {
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
