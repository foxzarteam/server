import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  UnauthorizedException,
} from '@nestjs/common';
import { adminInternalKeyOk } from '../common/admin-internal';
import { assertStrictMobileAccess, extractIdToken } from '../common/phone-access';
import { OtpService } from '../otp/otp.service';
import { UsersService } from '../users/users.service';
import { WalletService } from './wallet.service';

@Controller('wallet')
export class WalletController {
  constructor(
    private readonly walletService: WalletService,
    private readonly usersService: UsersService,
    private readonly otpService: OtpService,
  ) {}

  /** GET /api/wallet/user/:userId — public.wallet row for partner earning UI */
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
      await assertStrictMobileAccess(this.otpService, mobile, {
        adminKey,
        idToken: extractIdToken(headers),
      });
    }

    const row = await this.walletService.getOrCreateByUserId(userId);
    if (!row) {
      throw new NotFoundException('Wallet not found');
    }
    return { success: true, data: row };
  }
}
