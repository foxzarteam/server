import { Controller, Get, HttpCode, HttpStatus, Param } from '@nestjs/common';
import { WalletService } from './wallet.service';

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
