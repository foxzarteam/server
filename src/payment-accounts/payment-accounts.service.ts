import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Param,
  Put,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { adminInternalKeyOk } from '../common/admin-internal';
import { assertMobileAccess, extractIdToken } from '../common/phone-access';
import { SUPABASE_CLIENT } from '../config/supabase';
import { TABLE_PAYMENT_ACCOUNTS, getCurrentIsoTime } from '../common/constants';
import { OtpModule } from '../otp/otp.module';
import { OtpService } from '../otp/otp.service';
import { UsersModule } from '../users/users.module';
import { UsersService } from '../users/users.service';

import {
  UpsertPaymentAccountDto,
} from './payment-accounts.dto';

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
