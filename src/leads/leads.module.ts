import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Delete,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
  ValidateIf,
} from 'class-validator';
import { SUPABASE_CLIENT } from '../config/supabase';
import { adminInternalKeyOk } from '../common/admin-internal';
import { TABLE_LEADS, MSG_OTP_PHONE_NOT_VERIFIED } from '../common/constants';
import { OtpModule, OtpService } from '../otp/otp.module';

/** Placeholder until user completes the second-step form */
export const LEAD_DRAFT_FULL_NAME = 'Unknown';
export const LEAD_DRAFT_PAN = 'XXXXX0000X';

/** Matches active service slugs stored as lead category (e.g. personal-loan → personal_loan). */
const LEAD_CATEGORY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

class StartLeadDto {
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;

  @IsOptional()
  @IsString()
  @Matches(LEAD_CATEGORY_PATTERN, { message: 'Invalid category' })
  category?: string;
}

class CompleteLeadDto {
  @IsString()
  @Length(10, 10, { message: 'PAN must be 10 characters' })
  pan: string;

  @IsString()
  fullName: string;

  @IsOptional()
  @IsString()
  @Matches(LEAD_CATEGORY_PATTERN, { message: 'Invalid category' })
  category?: string;

  @IsOptional()
  @IsString()
  @Length(12, 12, { message: 'Aadhaar must be 12 digits' })
  @Matches(/^\d{12}$/, { message: 'Aadhaar must be 12 digits' })
  aadhaar?: string;
}

class CreateLeadDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsString()
  @Length(10, 10, { message: 'PAN must be 10 characters' })
  pan: string;

  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;

  @IsString()
  fullName: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  @ValidateIf((o) => o.pincode != null && o.pincode !== '')
  @Length(6, 6, { message: 'Pincode must be 6 digits' })
  pincode?: string;

  @IsOptional()
  @IsNumber()
  @ValidateIf((o) => o.requiredAmount != null)
  @Min(0, { message: 'Required amount must be positive' })
  requiredAmount?: number;

  @IsString()
  @Matches(LEAD_CATEGORY_PATTERN, {
    message: 'Invalid category (use service slug with underscores, e.g. personal_loan)',
  })
  category: string;
}

class UpdateLeadDto {
  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber?: string;

  @IsOptional()
  @IsString()
  @Length(10, 10, { message: 'PAN must be 10 characters' })
  pan?: string;

  @IsOptional()
  @IsString()
  @ValidateIf((o) => o.pincode != null && o.pincode !== '')
  @Length(6, 6, { message: 'Pincode must be 6 digits' })
  pincode?: string;

  @IsOptional()
  @IsNumber()
  @ValidateIf((o) => o.requiredAmount != null)
  @Min(0, { message: 'Required amount must be positive' })
  requiredAmount?: number;

  @IsOptional()
  @IsString()
  @Matches(LEAD_CATEGORY_PATTERN, { message: 'Invalid category' })
  category?: string;

  @IsOptional()
  @IsString()
  @IsIn(['pending', 'approved', 'rejected'], {
    message: 'Status must be one of: pending, approved, rejected',
  })
  status?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

@Injectable()
export class LeadsService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  private get leads() {
    return this.supabase.from(TABLE_LEADS);
  }

  isDraftLead(lead: Record<string, unknown>): boolean {
    const name = String(lead['full_name'] ?? '')
      .trim()
      .toLowerCase();
    const pan = String(lead['pan'] ?? '')
      .trim()
      .toUpperCase();
    return name === LEAD_DRAFT_FULL_NAME.toLowerCase() || pan === LEAD_DRAFT_PAN;
  }

  async getByMobile(mobileNumber: string): Promise<Record<string, unknown> | null> {
    const mobile = mobileNumber.trim();
    const { data, error } = await this.leads
      .select()
      .eq('mobile_number', mobile)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.getByMobile', error);
      }
      return null;
    }

    return (data as Record<string, unknown>) ?? null;
  }

  async createDraft(mobileNumber: string, category: string): Promise<Record<string, unknown> | null> {
    const payload: Record<string, unknown> = {
      pan: LEAD_DRAFT_PAN,
      mobile_number: mobileNumber.trim(),
      full_name: LEAD_DRAFT_FULL_NAME,
      email: null,
      pincode: null,
      required_amount: null,
      category: category || 'personal_loan',
      status: 'pending',
      is_active: true,
    };

    const { data, error } = await this.leads.insert(payload).select().single();

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.createDraft error:', error, payload);
      }
      return null;
    }

    return data as Record<string, unknown>;
  }

  async startLead(mobileNumber: string, category?: string): Promise<{
    ok: boolean;
    lead?: Record<string, unknown>;
    duplicate?: boolean;
  }> {
    const cat = category?.trim() || 'personal_loan';
    const existing = await this.getByMobile(mobileNumber);

    if (existing) {
      if (this.isDraftLead(existing)) {
        return { ok: true, lead: existing };
      }
      return { ok: false, duplicate: true };
    }

    const created = await this.createDraft(mobileNumber, cat);
    if (!created) return { ok: false };
    return { ok: true, lead: created };
  }

  async completeLead(
    id: string,
    dto: CompleteLeadDto,
  ): Promise<Record<string, unknown> | null> {
    const panUpper = dto.pan.trim().toUpperCase();
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(panUpper)) {
      return null;
    }

    const existing = await this.leads.select().eq('id', id).maybeSingle();
    if (existing.error || !existing.data) {
      return null;
    }

    const row = existing.data as Record<string, unknown>;
    const mobile = String(row['mobile_number'] ?? '').trim();
    const other = await this.getByMobile(mobile);
    if (
      other &&
      String(other['id']) !== id &&
      !this.isDraftLead(other)
    ) {
      return null;
    }

    return this.updateById(id, {
      pan: panUpper,
      fullName: dto.fullName.trim(),
      category: dto.category,
      notes: dto.aadhaar?.trim()
        ? `Aadhaar: ${dto.aadhaar.trim()}`
        : undefined,
    });
  }

  async create(dto: CreateLeadDto): Promise<Record<string, unknown> | null> {
    const panUpper = dto.pan.trim().toUpperCase();
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(panUpper)) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.create: Invalid PAN format', panUpper);
      }
      return null;
    }

    const payload: Record<string, unknown> = {
      pan: panUpper,
      mobile_number: dto.mobileNumber.trim(),
      full_name: dto.fullName.trim(),
      email: dto.email?.trim() || null,
      pincode: dto.pincode?.trim() || null,
      required_amount: dto.requiredAmount || null,
      category: dto.category || 'personal_loan',
      status: 'pending',
      is_active: true,
    };

    if (dto.userId && dto.userId.trim()) {
      payload.user_id = dto.userId.trim();
    }

    const { data, error } = await this.leads.insert(payload).select().single();

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.create error:', error, payload);
      }
      return null;
    }

    return data as Record<string, unknown>;
  }

  async getByUserId(userId: string): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.leads
      .select()
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.getByUserId', error);
      }
      return [];
    }

    return (data as Record<string, unknown>[]) || [];
  }

  async getByCategory(userId: string, category: string): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.leads
      .select()
      .eq('user_id', userId)
      .eq('category', category)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.getByCategory', error);
      }
      return [];
    }

    return (data as Record<string, unknown>[]) || [];
  }

  async getAll(): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.leads.select().order('created_at', { ascending: false });

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.getAll', error);
      }
      return [];
    }

    return (data as Record<string, unknown>[]) || [];
  }

  async updateById(id: string, dto: UpdateLeadDto): Promise<Record<string, unknown> | null> {
    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (dto.fullName != null) payload.full_name = dto.fullName.trim();
    if (dto.email !== undefined) payload.email = dto.email?.trim() || null;
    if (dto.mobileNumber != null) payload.mobile_number = dto.mobileNumber.trim();
    if (dto.pincode !== undefined) payload.pincode = dto.pincode?.trim() || null;
    if (dto.requiredAmount !== undefined) payload.required_amount = dto.requiredAmount ?? null;
    if (dto.category != null) payload.category = dto.category;
    if (dto.status != null) payload.status = dto.status;
    if (dto.notes !== undefined) payload.notes = dto.notes?.trim() || null;

    if (dto.pan != null) {
      const panUpper = dto.pan.trim().toUpperCase();
      if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(panUpper)) return null;
      payload.pan = panUpper;
    }

    if (Object.keys(payload).length === 1) return null;

    const { data, error } = await this.leads.update(payload).eq('id', id).select().single();

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.updateById', error);
      }
      return null;
    }

    return data as Record<string, unknown>;
  }

  async deleteById(id: string): Promise<boolean> {
    const { error } = await this.leads.delete().eq('id', id);

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.deleteById', error);
      }
      return false;
    }

    return true;
  }
}

@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leadsService: LeadsService,
    private readonly otpService: OtpService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async getAll() {
    return {
      success: true,
      message: 'Leads API is working! Use POST /api/leads to create a lead.',
      endpoints: {
        create: 'POST /api/leads',
        getByUser: 'GET /api/leads/user/:userId',
        getByCategory: 'GET /api/leads/user/:userId/category/:category',
      },
    };
  }

  @Post('start')
  @HttpCode(HttpStatus.OK)
  async start(@Body() dto: StartLeadDto) {
    const verified = await this.otpService.hasRecentPhoneVerification(
      dto.mobileNumber,
    );
    if (!verified) {
      return {
        success: false,
        message: MSG_OTP_PHONE_NOT_VERIFIED,
      };
    }

    const result = await this.leadsService.startLead(
      dto.mobileNumber,
      dto.category,
    );

    if (result.duplicate) {
      return {
        success: false,
        message: 'This number already exists.',
      };
    }

    if (!result.ok || !result.lead) {
      return { success: false, message: 'Failed to save mobile number. Please try again.' };
    }

    return { success: true, data: result.lead };
  }

  @Patch(':id/complete')
  @HttpCode(HttpStatus.OK)
  async complete(@Param('id') id: string, @Body() dto: CompleteLeadDto) {
    const lead = await this.leadsService.completeLead(id, dto);
    if (!lead) {
      return {
        success: false,
        message: 'Failed to update details. Please check PAN and try again.',
      };
    }
    return { success: true, data: lead };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateLeadDto) {
    try {
      const existing = await this.leadsService.getByMobile(dto.mobileNumber);
      if (existing && !this.leadsService.isDraftLead(existing)) {
        return {
          success: false,
          message: 'This number already exists.',
        };
      }

      if (existing && this.leadsService.isDraftLead(existing)) {
        const completed = await this.leadsService.completeLead(String(existing['id']), {
          pan: dto.pan,
          fullName: dto.fullName,
          category: dto.category,
        });
        if (!completed) {
          return { success: false, message: 'Failed to update lead' };
        }
        return { success: true, data: completed };
      }

      const lead = await this.leadsService.create(dto);
      if (!lead) {
        return { success: false, message: 'Failed to create lead' };
      }
      return { success: true, data: lead };
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsController.create', error);
      }
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to create lead',
      };
    }
  }

  @Get('user/:userId')
  @HttpCode(HttpStatus.OK)
  async getByUserId(@Param('userId') userId: string) {
    const leads = await this.leadsService.getByUserId(userId);
    return { success: true, data: leads };
  }

  @Get('user/:userId/category/:category')
  @HttpCode(HttpStatus.OK)
  async getByCategory(
    @Param('userId') userId: string,
    @Param('category') category: string,
  ) {
    const leads = await this.leadsService.getByCategory(userId, category);
    return { success: true, data: leads };
  }

  @Get('admin/all')
  @HttpCode(HttpStatus.OK)
  async getAllForAdmin(@Headers('x-admin-internal-key') adminKey: string | undefined) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const leads = await this.leadsService.getAll();
    return { success: true, data: leads };
  }

  @Patch('admin/:id')
  @HttpCode(HttpStatus.OK)
  async updateForAdmin(
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdateLeadDto,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const lead = await this.leadsService.updateById(id, dto);
    if (!lead) {
      throw new NotFoundException('Lead not found or update failed');
    }
    return { success: true, data: lead };
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
    const ok = await this.leadsService.deleteById(id);
    if (!ok) {
      throw new NotFoundException('Lead not found or delete failed');
    }
    return { success: true };
  }
}

@Module({
  imports: [OtpModule],
  controllers: [LeadsController],
  providers: [LeadsService],
})
export class LeadsModule {}
