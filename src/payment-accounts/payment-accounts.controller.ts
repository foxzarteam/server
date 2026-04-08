import { Body, Controller, Get, HttpCode, HttpStatus, Param, Put } from '@nestjs/common';
import { PaymentAccountsService } from './payment-accounts.service';
import { UpsertPaymentAccountDto } from './dto/upsert-payment-account.dto';

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
  async upsert(
    @Param('userId') userId: string,
    @Body() dto: UpsertPaymentAccountDto,
  ) {
    const row = await this.paymentAccountsService.upsert(userId, dto);
    if (!row) {
      return { success: false, message: 'Failed to save payment details' };
    }
    return { success: true, data: row };
  }
}
