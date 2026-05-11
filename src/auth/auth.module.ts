import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  Module,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { IsEmail, IsString, MinLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { SUPABASE_CLIENT } from '../config/supabase';
import { TABLE_AUTH } from '../common/constants';

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

/** bcrypt hashes start with $2a$, $2b$, or $2y$ */
function storedPasswordLooksBcrypt(stored: string): boolean {
  return /^\$2[aby]\$\d{2}\$/.test(stored);
}

@Injectable()
export class AuthService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  private get table() {
    return this.supabase.from(TABLE_AUTH);
  }

  private async passwordOk(plain: string, storedRaw: string): Promise<boolean> {
    const stored = storedRaw.trim();
    const p = plain.trim();
    if (!stored) return false;
    if (storedPasswordLooksBcrypt(stored)) {
      return bcrypt.compare(p, stored);
    }
    // Plain-text passwords in DB (not recommended prod); helps existing rows.
    return p === stored;
  }

  /**
   * Validates credentials against `public.auth`.
   * Prefer bcrypt hashes in `password`; plain text is accepted only if the value is not a bcrypt hash.
   */
  async verifyAdminLogin(email: string, plainPassword: string): Promise<AuthUserPublic> {
    const normalized = email.trim().toLowerCase();
    // Case-insensitive email match (DB may store Info@... while we compare info@...).
    const { data, error } = await this.table
      .select('id, full_name, email, password, role')
      .ilike('email', normalized)
      .maybeSingle();

    if (error) {
      console.error('AuthService.verifyAdminLogin', error);
      if (process.env.NODE_ENV !== 'production') {
        throw new InternalServerErrorException(
          `Auth database error: ${error.message}. Use Project Settings → API → service_role in server/.env (not anon / publishable).`,
        );
      }
      throw new UnauthorizedException('Invalid email or password');
    }

    const row = data as AuthRow | null;
    if (!row?.password) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const ok = await this.passwordOk(plainPassword, row.password);
    if (!ok) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (row.role !== 'admin' && row.role !== 'staff') {
      throw new UnauthorizedException('Invalid email or password');
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
