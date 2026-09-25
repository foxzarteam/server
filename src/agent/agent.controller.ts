import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { AdminActor } from '../common/admin-actor';
import { PartnerAccessGuard } from '../common/partner-access.guard';
import { sanitizeUserPublic } from '../common/mpin';
import { AdminCreateLeadDto } from '../leads/leads.dto';
import { LeadsService } from '../leads/leads.service';
import {
  CODE_MOBILE_PAN_LIMIT_REACHED,
  LeadRuleError,
} from '../leads/mobile-pan-limit';
import { UpsertPaymentAccountDto } from '../payment-accounts/payment-accounts.dto';
import { PaymentAccountsService } from '../payment-accounts/payment-accounts.service';
import { UpdateMpinDto, UpdateProfileDto } from '../users/users.dto';
import { UsersService } from '../users/users.service';
import { WalletService } from '../wallet/wallet.service';
import { WalletSyncError } from '../wallet/wallet-sync';
import { sanitizePublicLead } from '../security/pan-crypto';

type PartnerReq = { partnerActor?: AdminActor };

@Controller('agent')
@UseGuards(PartnerAccessGuard)
export class AgentController {
  constructor(
    private readonly usersService: UsersService,
    private readonly leadsService: LeadsService,
    private readonly walletService: WalletService,
    private readonly paymentAccountsService: PaymentAccountsService,
  ) {}

  private actorId(req: PartnerReq): string {
    return String(req.partnerActor?.sub ?? '').trim();
  }

  @Get('me')
  @HttpCode(HttpStatus.OK)
  async me(@Req() req: PartnerReq) {
    const user = await this.usersService.getById(this.actorId(req));
    if (!user || user.is_active === false) {
      throw new NotFoundException('User not found');
    }
    return { success: true, data: sanitizeUserPublic(user) };
  }

  @Patch('me')
  @HttpCode(HttpStatus.OK)
  async updateMe(@Req() req: PartnerReq, @Body() dto: UpdateProfileDto) {
    const user = await this.usersService.updateProfileById(this.actorId(req), dto);
    if (!user) {
      throw new NotFoundException('User not found or update failed');
    }
    return { success: true, data: user };
  }

  @Patch('me/mpin')
  @HttpCode(HttpStatus.OK)
  async updateMyMpin(@Req() req: PartnerReq, @Body() dto: UpdateMpinDto) {
    const user = await this.usersService.getById(this.actorId(req));
    const mobile = String(user?.mobile_number ?? '').trim();
    if (!mobile) {
      throw new NotFoundException('User not found');
    }
    const ok = await this.usersService.updateMpin(mobile, dto.mpin);
    return { success: ok };
  }

  @Get('leads')
  @HttpCode(HttpStatus.OK)
  async myLeads(@Req() req: PartnerReq) {
    const leads = await this.leadsService.getByAgentId(this.actorId(req));
    return { success: true, data: leads.map((l) => sanitizePublicLead(l)) };
  }

  @Post('leads')
  @HttpCode(HttpStatus.CREATED)
  async createLead(@Req() req: PartnerReq, @Body() dto: AdminCreateLeadDto) {
    try {
      const result = await this.leadsService.createForPartner(dto, this.actorId(req));
      if (!result.ok) {
        const conflict =
          result.code === CODE_MOBILE_PAN_LIMIT_REACHED ||
          result.message.toLowerCase().includes('already');
        throw new HttpException(
          {
            success: false,
            message: result.message || 'Failed to create lead',
            code: result.code,
            field: result.field,
          },
          conflict ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST,
        );
      }
      return { success: true, data: sanitizePublicLead(result.lead) };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (err instanceof WalletSyncError) {
        throw new HttpException(
          { success: false, message: err.message, code: err.code },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      if (err instanceof LeadRuleError) {
        throw new HttpException(
          { success: false, message: err.message, code: err.code },
          HttpStatus.CONFLICT,
        );
      }
      throw err;
    }
  }

  @Get('wallet')
  @HttpCode(HttpStatus.OK)
  async wallet(@Req() req: PartnerReq) {
    const row = await this.walletService.getOrCreateByUserId(this.actorId(req));
    if (!row) {
      throw new NotFoundException('Wallet not found');
    }
    return { success: true, data: row };
  }

  @Get('payment-accounts')
  @HttpCode(HttpStatus.OK)
  async paymentAccounts(@Req() req: PartnerReq) {
    const list = await this.paymentAccountsService.getByUserId(this.actorId(req));
    return { success: true, data: list };
  }

  @Put('payment-accounts')
  @HttpCode(HttpStatus.OK)
  async savePaymentAccount(
    @Req() req: PartnerReq,
    @Body() dto: UpsertPaymentAccountDto,
  ) {
    const row = await this.paymentAccountsService.upsert(this.actorId(req), dto);
    if (!row) {
      return { success: false, message: 'Failed to save payment details' };
    }
    return { success: true, data: row };
  }
}
