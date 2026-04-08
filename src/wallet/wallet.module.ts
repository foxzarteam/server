import { Controller, Get, HttpCode, HttpStatus, Inject, Injectable, Module, Param } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../config/supabase';
import { TABLE_WALLET } from '../common/constants';

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
  constructor(private readonly walletService: WalletService) {}

  @Get('user/:userId')
  @HttpCode(HttpStatus.OK)
  async getByUserId(@Param('userId') userId: string) {
    const row = await this.walletService.getByUserId(userId);
    if (!row) {
      return { success: false, message: 'Wallet not found' };
    }
    return { success: true, data: row };
  }
}

@Module({
  controllers: [WalletController],
  providers: [WalletService],
})
export class WalletModule {}
