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
import { assertStrictMobileAccess, extractIdToken } from '../common/phone-access';
import { SUPABASE_CLIENT } from '../config/supabase';
import { TABLE_PAYMENT_ACCOUNTS, getCurrentIsoTime } from '../common/constants';
import { OtpService } from '../otp/otp.service';
import { UsersService } from '../users/users.service';

import {
  UpsertPaymentAccountDto,
} from './payment-accounts.dto';
import { PaymentAccountsService } from './payment-accounts.service';

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
    await assertStrictMobileAccess(this.otpService, mobile, {
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
