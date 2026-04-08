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
  Put,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { SUPABASE_CLIENT } from '../config/supabase';
import { TABLE_PAYMENT_ACCOUNTS, getCurrentIsoTime } from '../common/constants';

class UpsertPaymentAccountDto {
  @IsString()
  @IsIn(['upi', 'bank'])
  paymentType: 'upi' | 'bank';

  @IsOptional()
  @IsString()
  @MaxLength(255)
  upiId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  bankName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  ifscCode?: string;
}

@Injectable()
export class PaymentAccountsService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  private get table() {
    return this.supabase.from(TABLE_PAYMENT_ACCOUNTS);
  }

  async getByUserId(userId: string): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.table
      .select('id, payment_type, upi_id, bank_name, ifsc_code, created_at, updated_at')
      .eq('user_id', userId.trim())
      .order('payment_type');
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('PaymentAccountsService.getByUserId', error);
      }
      return [];
    }
    return (data ?? []) as Record<string, unknown>[];
  }

  async upsert(
    userId: string,
    dto: UpsertPaymentAccountDto,
  ): Promise<Record<string, unknown> | null> {
    const uid = userId.trim();
    const payload: Record<string, unknown> = {
      user_id: uid,
      payment_type: dto.paymentType,
      updated_at: getCurrentIsoTime(),
    };
    if (dto.paymentType === 'upi') {
      payload.upi_id = dto.upiId?.trim() ?? null;
      payload.bank_name = null;
      payload.ifsc_code = null;
    } else {
      payload.upi_id = null;
      payload.bank_name = dto.bankName?.trim() ?? null;
      payload.ifsc_code = dto.ifscCode?.trim() ?? null;
    }

    const { data, error } = await this.table
      .upsert(payload, {
        onConflict: 'user_id,payment_type',
      })
      .select()
      .single();

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('PaymentAccountsService.upsert', error);
      }
      return null;
    }
    return data as Record<string, unknown>;
  }
}

@Controller('payment-accounts')
export class PaymentAccountsController {
  constructor(private readonly paymentAccountsService: PaymentAccountsService) {}

  @Get('user/:userId')
  @HttpCode(HttpStatus.OK)
  async getByUserId(@Param('userId') userId: string) {
    const list = await this.paymentAccountsService.getByUserId(userId);
    return { success: true, data: list };
  }

  @Put('user/:userId')
  @HttpCode(HttpStatus.OK)
  async upsert(@Param('userId') userId: string, @Body() dto: UpsertPaymentAccountDto) {
    const row = await this.paymentAccountsService.upsert(userId, dto);
    if (!row) {
      return { success: false, message: 'Failed to save payment details' };
    }
    return { success: true, data: row };
  }
}

@Module({
  controllers: [PaymentAccountsController],
  providers: [PaymentAccountsService],
})
export class PaymentAccountsModule {}
