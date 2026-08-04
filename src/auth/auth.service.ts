import { Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import * as bcrypt from 'bcryptjs';
import { SUPABASE_CLIENT } from '../config/supabase';
import { TABLE_AUTH } from '../common/constants';
import {
  AdminLoginDto,
  AUTH_FAIL,
  AuthRow,
  AuthUserPublic,
  normalizeStoredCredential,
  storedPasswordLooksBcrypt,
} from './auth.dto';

@Injectable()
export class AuthService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  /** `public.auth` — explicit `public` avoids clashing with Supabase’s built-in `auth` schema. */
  private get table() {
    return this.supabase.schema('public').from(TABLE_AUTH);
  }

  private async passwordOk(plain: string, storedRaw: string | null | undefined): Promise<boolean> {
    const stored = normalizeStoredCredential(String(storedRaw ?? ''));
    const p = String(plain ?? '')
      .replace(/^\uFEFF/, '')
      .trim();
    if (!stored || !storedPasswordLooksBcrypt(stored)) return false;
    try {
      return await bcrypt.compare(p, stored);
    } catch {
      return false;
    }
  }

  /** `public.auth`: email row + bcrypt password + role admin|staff. */
  async verifyAdminLogin(email: string, plainPassword: string): Promise<AuthUserPublic> {
    const trimmed = email.trim();
    const normalized = trimmed.toLowerCase();
    const emailCandidates = [...new Set([normalized, trimmed].filter((s) => s.length > 0))];

    let row: AuthRow | null = null;
    let error: { message: string } | null = null;

    for (const emailKey of emailCandidates) {
      let res = await this.table
        .select('id, full_name, email, password, role')
        .eq('email', emailKey)
        .maybeSingle();
      if (res.error) {
        error = res.error;
        break;
      }
      let data = res.data as AuthRow | null;
      if (!data) {
        res = await this.table
          .select('id, full_name, email, password, role')
          .ilike('email', emailKey)
          .maybeSingle();
        if (res.error) {
          error = res.error;
          break;
        }
        data = res.data as AuthRow | null;
      }
      if (!data) continue;

      if (data.role !== 'admin' && data.role !== 'staff') {
        throw new UnauthorizedException(AUTH_FAIL);
      }
      const storedPwd = String(data.password ?? "");
      if (!normalizeStoredCredential(storedPwd)) {
        throw new UnauthorizedException(AUTH_FAIL);
      }
      if (!(await this.passwordOk(plainPassword, storedPwd))) {
        throw new UnauthorizedException(AUTH_FAIL);
      }
      row = data;
      break;
    }

    if (error) {
      console.error('AuthService.verifyAdminLogin', error);
      throw new ServiceUnavailableException('Login temporarily unavailable.');
    }

    if (!row) {
      throw new UnauthorizedException(AUTH_FAIL);
    }

    return {
      id: String(row.id),
      email: row.email,
      role: row.role,
      full_name: row.full_name,
    };
  }
}
