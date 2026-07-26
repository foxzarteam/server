import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { IsEmail, IsString, MinLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { SUPABASE_CLIENT } from '../config/supabase';
import { TABLE_AUTH } from '../common/constants';

const AUTH_FAIL = 'Invalid email or password';

class AdminLoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(1, { message: 'Password is required' })
  password: string;
}

export type AuthUserPublic = {
  id: string;
  email: string;
  role: string;
  full_name: string;
};

type AuthRow = {
  id: string;
  full_name: string;
  email: string;
  password: string;
  role: string;
};

/** Real bcrypt hashes are ~60 chars and match this prefix; avoids treating odd strings as bcrypt. */
function storedPasswordLooksBcrypt(stored: string): boolean {
  const s = stored.trim();
  return s.length >= 59 && /^\$2[aby]\$\d{2}\$/.test(s);
}

function normalizeStoredCredential(raw: string): string {
  let v = raw.replace(/^\uFEFF/, "").trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

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

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: AdminLoginDto) {
    const user = await this.authService.verifyAdminLogin(dto.email, dto.password);
    return { ok: true, user };
  }
}

@Module({
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
