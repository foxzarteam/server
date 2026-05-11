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
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { IsEmail, IsString, MinLength } from 'class-validator';
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
  role: string;
};

@Injectable()
export class AuthService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  /** `public.auth` admin rows — `.schema('public')` avoids clashing with Supabase’s built-in `auth` schema. */
  private get table() {
    return this.supabase.schema('public').from(TABLE_AUTH);
  }

  /**
   * Admin login: row must exist in `public.auth` for this email with role admin or staff.
   * Password is not checked against the database (form still sends it).
   */
  async verifyAdminLogin(email: string, _plainPassword: string): Promise<AuthUserPublic> {
    const trimmed = email.trim();
    const normalized = trimmed.toLowerCase();
    const emailCandidates = [...new Set([normalized, trimmed].filter((s) => s.length > 0))];

    let row: AuthRow | null = null;
    let error: { message: string } | null = null;

    for (const emailKey of emailCandidates) {
      const res = await this.table
        .select('id, full_name, email, role')
        .eq('email', emailKey)
        .maybeSingle();
      if (res.error) {
        error = res.error;
        break;
      }
      const data = res.data as AuthRow | null;
      if (!data) continue;
      if (data.role !== 'admin' && data.role !== 'staff') {
        throw new UnauthorizedException(
          `This account has role "${data.role}"; only admin or staff can sign in here.`,
        );
      }
      row = data;
      break;
    }

    if (error) {
      console.error('AuthService.verifyAdminLogin', error);
      if (process.env.NODE_ENV !== 'production') {
        throw new InternalServerErrorException(
          `Auth database error: ${error.message}. Use Project Settings → API → service_role in server/.env (not anon / publishable).`,
        );
      }
      throw new ServiceUnavailableException(
        `Cannot read admin users from the database (${error.message}). Check SUPABASE_URL and service_role key on this API server.`,
      );
    }

    if (!row) {
      throw new UnauthorizedException(
        'No admin row was returned for this email. If the row exists in Table Editor, Nest is usually pointed at a different Supabase project: set Vercel (or server/.env) SUPABASE_URL and SUPABASE_SERVICE_KEY to this project under Project Settings → API. Otherwise add the row in SQL Editor (public.auth, role admin or staff).',
      );
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
