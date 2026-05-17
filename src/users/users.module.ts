import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  UnauthorizedException,
} from '@nestjs/common';
import { adminInternalKeyOk } from '../common/admin-internal';
import { SupabaseClient } from '@supabase/supabase-js';
import { IsBoolean, IsOptional, IsString, Length, Matches } from 'class-validator';
import { SUPABASE_CLIENT } from '../config/supabase';
import { MSG_USER_CREATE_FAILED, TABLE_USERS, getCurrentIsoTime } from '../common/constants';

class CreateUserDto {
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;

  @IsOptional()
  @IsString()
  userName?: string;

  @IsOptional()
  @IsString()
  email?: string;
}

class UpsertUserDto {
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;

  @IsOptional()
  @IsString()
  userName?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  @Length(4, 4, { message: 'mpin must be 4 digits' })
  @Matches(/^\d{4}$/, { message: 'mpin must be 4 digits' })
  mpin?: string;

  @IsOptional()
  @IsBoolean()
  isLoggedIn?: boolean;
}

class UpdateProfileDto {
  @IsOptional()
  @IsString()
  userName?: string;

  @IsOptional()
  @IsString()
  email?: string;
}

class UpdateMpinDto {
  @IsString()
  @Length(4, 4, { message: 'mpin must be 4 digits' })
  @Matches(/^\d{4}$/, { message: 'mpin must be 4 digits' })
  mpin: string;
}

class UpdateLoginStatusDto {
  @IsBoolean()
  isLoggedIn: boolean;
}

class AdminUpdateUserDto {
  @IsOptional()
  @IsString()
  userName?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isLoggedIn?: boolean;
}

const MPIN_LENGTH = 4;
const DEFAULT_USER_NAME = 'User';

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

  async updateMpin(mobile: string, dto: UpdateMpinDto): Promise<boolean> {
    const { error } = await this.users
      .update({
        mpin: dto.mpin.trim(),
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

  private buildUpsertUpdatePayload(dto: UpsertUserDto): Record<string, unknown> | null {
    const now = getCurrentIsoTime();
    const payload: Record<string, unknown> = { updated_at: now };
    if (dto.userName != null) payload.user_name = dto.userName;
    if (dto.email != null) payload.email = dto.email;
    if (dto.mpin != null) {
      const trimmed = dto.mpin.trim();
      if (trimmed.length !== MPIN_LENGTH) return null;
      payload.mpin = trimmed;
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
      mpin: dto.mpin != null ? dto.mpin.trim() : null,
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
      const updatePayload = this.buildUpsertUpdatePayload(dto);
      if (updatePayload == null) return false;
      const ok = await this.updateUser(dto.mobileNumber, updatePayload);
      if (!ok) return false;
      if (dto.mpin != null) {
        const verify = await this.getByMobile(dto.mobileNumber);
        const saved = (verify?.mpin as string)?.trim() ?? '';
        if (saved !== dto.mpin.trim()) return false;
      }
      return true;
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

    return (data as Record<string, unknown>[]) || [];
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

    return data as Record<string, unknown>;
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

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('admin/all')
  @HttpCode(HttpStatus.OK)
  async getAllForAdmin(@Headers('x-admin-internal-key') adminKey: string | undefined) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const users = await this.usersService.getAll();
    return { success: true, data: users };
  }

  @Patch('admin/:id')
  @HttpCode(HttpStatus.OK)
  async updateForAdmin(
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Param('id') id: string,
    @Body() dto: AdminUpdateUserDto,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const user = await this.usersService.updateById(id, dto);
    if (!user) {
      throw new NotFoundException('User not found or update failed');
    }
    return { success: true, data: user };
  }

  @Delete('admin/:id')
  @HttpCode(HttpStatus.OK)
  async deleteForAdmin(
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Param('id') id: string,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const ok = await this.usersService.deleteById(id);
    if (!ok) {
      throw new NotFoundException('User not found or delete failed');
    }
    return { success: true };
  }

  @Get('mobile/:mobile')
  @HttpCode(HttpStatus.OK)
  async getByMobile(@Param('mobile') mobile: string) {
    const user = await this.usersService.getByMobile(mobile);
    if (!user) return { success: false, data: null };
    return { success: true, data: user };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateUserDto) {
    const user = await this.usersService.create(dto);
    if (!user) return { success: false, message: MSG_USER_CREATE_FAILED };
    return { success: true, data: user };
  }

  @Patch('mobile/:mobile/mpin')
  @HttpCode(HttpStatus.OK)
  async updateMpin(@Param('mobile') mobile: string, @Body() dto: UpdateMpinDto) {
    const ok = await this.usersService.updateMpin(mobile, dto);
    return { success: ok };
  }

  @Patch('mobile/:mobile/login-status')
  @HttpCode(HttpStatus.OK)
  async updateLoginStatus(
    @Param('mobile') mobile: string,
    @Body() dto: UpdateLoginStatusDto,
  ) {
    const ok = await this.usersService.updateLoginStatus(mobile, dto);
    return { success: ok };
  }

  @Patch('mobile/:mobile/profile')
  @HttpCode(HttpStatus.OK)
  async updateProfile(@Param('mobile') mobile: string, @Body() dto: UpdateProfileDto) {
    const ok = await this.usersService.updateProfile(mobile, dto);
    return { success: ok };
  }

  @Put('upsert')
  @HttpCode(HttpStatus.OK)
  async upsert(@Body() dto: UpsertUserDto) {
    const ok = await this.usersService.upsert(dto);
    return { success: ok };
  }
}

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
