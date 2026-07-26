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
  Put,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { adminInternalKeyOk } from '../common/admin-internal';
import { assertMobileAccess, extractIdToken } from '../common/phone-access';
import { SUPABASE_CLIENT } from '../config/supabase';
import { TABLE_PAYMENT_ACCOUNTS, getCurrentIsoTime } from '../common/constants';
import { OtpModule, OtpService } from '../otp/otp.module';
import { UsersModule, UsersService } from '../users/users.module';

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

  @IsOptional()
  @IsString()
  @MinLength(20)
  idToken?: string;
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
  constructor(
    private readonly paymentAccountsService: PaymentAccountsService,
    private readonly usersService: UsersService,
    private readonly otpService: OtpService,
  ) {}

  private async assertUserAccess(
    userId: string,
    adminKey: string | undefined,
    headers: Record<string, string | string[] | undefined>,
    bodyToken?: string,
  ) {
    if (adminInternalKeyOk(adminKey)) return;
    const user = await this.usersService.getById(userId);
    const mobile = String(user?.mobile_number ?? '').trim();
    if (!mobile) throw new UnauthorizedException('Unauthorized');
    await assertMobileAccess(this.otpService, mobile, {
      adminKey,
      idToken: extractIdToken(headers, bodyToken),
    });
  }

  @Get('user/:userId')
  @HttpCode(HttpStatus.OK)
  async getByUserId(
    @Param('userId') userId: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Headers('x-admin-internal-key') adminKey: string | undefined,
  ) {
    await this.assertUserAccess(userId, adminKey, headers);
    const list = await this.paymentAccountsService.getByUserId(userId);
    return { success: true, data: list };
  }

  @Put('user/:userId')
  @HttpCode(HttpStatus.OK)
  async upsert(
    @Param('userId') userId: string,
    @Body() dto: UpsertPaymentAccountDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Headers('x-admin-internal-key') adminKey: string | undefined,
  ) {
    await this.assertUserAccess(userId, adminKey, headers, dto.idToken);
    const row = await this.paymentAccountsService.upsert(userId, dto);
    if (!row) {
      return { success: false, message: 'Failed to save payment details' };
    }
    return { success: true, data: row };
  }
}

@Module({
  imports: [UsersModule, OtpModule],
  controllers: [PaymentAccountsController],
  providers: [PaymentAccountsService],
})
export class PaymentAccountsModule {}
