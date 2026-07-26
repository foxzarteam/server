import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { adminInternalKeyOk } from '../common/admin-internal';
import { assertMobileAccess, extractIdToken } from '../common/phone-access';
import { SUPABASE_CLIENT } from '../config/supabase';
import { TABLE_WALLET } from '../common/constants';
import { OtpModule, OtpService } from '../otp/otp.module';
import { UsersModule, UsersService } from '../users/users.module';

@Injectable()
export class WalletService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  private get table() {
    return this.supabase.from(TABLE_WALLET);
  }

  async getByUserId(userId: string): Promise<Record<string, unknown> | null> {
    const uid = userId.trim();
    const { data, error } = await this.table
      .select('id, user_id, earning, redeem, balance, currency, created_at, updated_at')
      .eq('user_id', uid)
      .maybeSingle();

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('WalletService.getByUserId', error);
      }
      return null;
    }
    return data as Record<string, unknown> | null;
  }
}

@Controller('wallet')
export class WalletController {
  constructor(
    private readonly walletService: WalletService,
    private readonly usersService: UsersService,
    private readonly otpService: OtpService,
  ) {}

  @Get('user/:userId')
  @HttpCode(HttpStatus.OK)
  async getByUserId(
    @Param('userId') userId: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Headers('x-admin-internal-key') adminKey: string | undefined,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      const user = await this.usersService.getById(userId);
      const mobile = String(user?.mobile_number ?? '').trim();
      if (!mobile) throw new UnauthorizedException('Unauthorized');
      await assertMobileAccess(this.otpService, mobile, {
        adminKey,
        idToken: extractIdToken(headers),
      });
    }

    const row = await this.walletService.getByUserId(userId);
    if (!row) {
      throw new NotFoundException('Wallet not found');
    }
    return { success: true, data: row };
  }
}

@Module({
  imports: [UsersModule, OtpModule],
  controllers: [WalletController],
  providers: [WalletService],
})
export class WalletModule {}
