import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common';
import { WalletReadGuard } from '../common/admin-crm.guard';
import { WalletService } from './wallet.service';

@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  /** GET /api/wallet/user/:userId — partner earnings. Actor must own the wallet, or be admin/staff. */
  @Get('user/:userId')
  @UseGuards(WalletReadGuard)
  @HttpCode(HttpStatus.OK)
  async getByUserId(@Param('userId') userId: string) {
    const row = await this.walletService.getOrCreateByUserId(userId);
    if (!row) {
      throw new NotFoundException('Wallet not found');
    }
    return { success: true, data: row };
  }
}
