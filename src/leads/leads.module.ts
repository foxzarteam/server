import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
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
}

@Module({
  controllers: [LeadsController],
  providers: [LeadsService],
})
export class LeadsModule {}
