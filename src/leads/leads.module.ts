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
import { TABLE_LEADS } from '../common/constants';

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
  @IsIn(
    [
      'personal_loan',
      'home_loan',
      'business_loan',
      'credit_card',
      'insurance',
      'vehicle_loan',
    ],
    {
      message:
        'Category must be one of: personal_loan, home_loan, business_loan, credit_card, insurance, vehicle_loan',
    },
  )
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
  @IsIn(
    [
      'personal_loan',
      'home_loan',
      'business_loan',
      'credit_card',
      'insurance',
      'vehicle_loan',
    ],
    {
      message:
        'Category must be one of: personal_loan, home_loan, business_loan, credit_card, insurance, vehicle_loan',
    },
  )
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
  constructor(private readonly leadsService: LeadsService) {}

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

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateLeadDto) {
    try {
      const duplicateCheck = await this.leadsService.getByUserId(dto.userId ?? '').catch(
        () => [] as Record<string, unknown>[],
      );

      if (
        duplicateCheck.some(
          (l) => (l['mobile_number'] as string | undefined)?.trim() === dto.mobileNumber.trim(),
        )
      ) {
        return {
          success: false,
          message: 'This lead already exists in our system.',
        };
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
  controllers: [LeadsController],
  providers: [LeadsService],
})
export class LeadsModule {}
