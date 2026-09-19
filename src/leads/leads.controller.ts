import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Delete,
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
  HttpException,
  UseGuards,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AdminActor } from '../common/admin-actor';
import {
  extractAdminActorToken,
  isCrmAdminActor,
  verifyAdminActor,
} from '../common/admin-actor';
import { AdminCrmGuard, AdminOnlyGuard, AdminPanelGuard } from '../common/admin-crm.guard';
import { adminInternalKeyOk } from '../common/admin-internal';
import { MobileAccessGuard } from '../common/mobile-access.guard';
import {
  assertLeadPiiAccess,
  assertMobileAccess,
  extractIdToken,
} from '../common/phone-access';
import { MSG_OTP_PHONE_NOT_VERIFIED } from '../common/constants';
import { OtpService } from '../otp/otp.service';
import { UsersService } from '../users/users.service';
import { sanitizePublicLead } from '../security/pan-crypto';
import { allowRateLimitedAction } from '../security/rate-limit';
import { extractClientIp } from '../common/client-ip';
import { toPublicErrorMessage } from '../common/public-error';
import {
  AdminCreateLeadDto,
  CheckApplicationDto,
  CompleteLeadDto,
  CreateLeadDto,
  RevealPanDto,
  StartLeadDto,
  UpdateLeadDto,
} from './leads.dto';
import { LeadsService } from './leads.service';
import {
  CODE_MOBILE_PAN_LIMIT_REACHED,
  LeadRuleError,
} from './mobile-pan-limit';
import {
  CODE_APPROVE_ADMIN_ONLY,
  MSG_APPROVE_ADMIN_ONLY,
  WalletSyncError,
} from '../wallet/wallet-sync';
import { CODE_LOAN_AMOUNT_REQUIRED } from '../wallet/loan-amount';

@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leadsService: LeadsService,
    private readonly otpService: OtpService,
    private readonly usersService: UsersService,
  ) {}

  private throwLeadWriteFailure(message: string, code?: string): never {
    const body = {
      success: false,
      message,
      ...(code ? { code } : {}),
    };
    const conflict =
      code === CODE_MOBILE_PAN_LIMIT_REACHED ||
      message.toLowerCase().includes('already');
    throw new HttpException(
      body,
      conflict ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST,
    );
  }

  private rethrowLeadMutation(err: unknown): never {
    if (err instanceof WalletSyncError) {
      throw new HttpException(
        {
          success: false,
          message: err.message,
          code: err.code,
          leadStatusSaved: err.leadStatusSaved,
        },
        err.leadStatusSaved
          ? HttpStatus.INTERNAL_SERVER_ERROR
          : HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (err instanceof LeadRuleError) {
      const status =
        err.code === CODE_APPROVE_ADMIN_ONLY
          ? HttpStatus.FORBIDDEN
          : err.code === CODE_LOAN_AMOUNT_REQUIRED
            ? HttpStatus.BAD_REQUEST
            : HttpStatus.CONFLICT;
      throw new HttpException(
        {
          success: false,
          message: err.message,
          code: err.code,
        },
        status,
      );
    }
    throw err;
  }

  private sanitizePublicLead(lead: Record<string, unknown>): Record<string, unknown> {
    return sanitizePublicLead(lead);
  }

  private clientIp(req: Request): string | null {
    return extractClientIp(
      req.headers as Record<string, string | string[] | undefined>,
      req.ip ?? req.socket?.remoteAddress,
    );
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  async getAll() {
    return {
      success: true,
      message: 'Leads API is working! Prefer POST /api/leads/apply for new applications.',
      endpoints: {
        apply: 'POST /api/leads/apply',
        start: 'POST /api/leads/start',
        getByUser: 'GET /api/leads/user/:userId (auth required)',
      },
    };
  }

  @Post('start')
  @HttpCode(HttpStatus.OK)
  async start(@Body() dto: StartLeadDto, @Req() req: Request) {
    const verified = await this.otpService.hasRecentPhoneVerification(
      dto.mobileNumber,
    );
    if (!verified) {
      return {
        success: false,
        message: MSG_OTP_PHONE_NOT_VERIFIED,
      };
    }

    const result = await this.leadsService.startLead(
      dto.mobileNumber,
      dto.category,
      this.clientIp(req),
      dto.referralCode,
    );

    if (!result.ok || !result.lead) {
      return {
        success: false,
        message: result.message || 'Failed to save mobile number. Please try again.',
      };
    }

    return {
      success: true,
      data: this.sanitizePublicLead(result.lead),
      isDraft: result.isDraft === true,
    };
  }

  /**
   * Public pre-OTP check: Gate 1 max 4 unique PANs per mobile, then same PAN + product.
   * Does not require Firebase/OTP — only rate-limited.
   */
  @Post('check-application')
  @HttpCode(HttpStatus.OK)
  async checkApplication(@Body() dto: CheckApplicationDto, @Req() req: Request) {
    const mobile = dto.mobileNumber.trim();
    const ip = this.clientIp(req) || 'unknown';
    if (
      !allowRateLimitedAction(`lead-check:${mobile}`, 12, 60_000) ||
      !allowRateLimitedAction(`lead-check-ip:${ip}`, 30, 60_000)
    ) {
      throw new BadRequestException('Too many checks. Please try again in a minute.');
    }

    const result = await this.leadsService.checkApplicationAllowed({
      mobileNumber: mobile,
      pan: dto.pan,
      category: dto.category,
      insType: dto.insType,
    });

    return {
      success: true,
      allowed: result.allowed,
      message: result.message,
      code: result.code,
      status: result.status,
      statusLabel: result.statusLabel,
      category: result.category,
      categoryLabel: result.categoryLabel,
      insType: result.insType,
    };
  }

  /**
   * Public apply: require phone verification (Firebase or recent OTP) before storing PAN.
   * Gate 1: max 4 unique PANs per mobile. Gate 2: same PAN + product unless approved.
   */
  @Post('apply')
  @HttpCode(HttpStatus.CREATED)
  async apply(
    @Body() dto: CreateLeadDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Req() req: Request,
  ) {
    const mobile = dto.mobileNumber?.trim() ?? '';
    if (mobile && !allowRateLimitedAction(`lead-apply:${mobile}`, 8, 60_000)) {
      throw new BadRequestException('Too many applications. Please try again in a minute.');
    }

    await assertLeadPiiAccess(this.otpService, mobile, {
      adminKey,
      idToken: extractIdToken(headers, dto.idToken),
    });

    const result = await this.leadsService.applyLead(dto, {
      clientIp: this.clientIp(req),
    });
    if (!result.ok || !result.lead) {
      this.throwLeadWriteFailure(result.message || 'Failed to create lead', result.code);
    }
    return { success: true, data: this.sanitizePublicLead(result.lead) };
  }

  @Patch(':id/complete')
  @HttpCode(HttpStatus.OK)
  async complete(
    @Param('id') id: string,
    @Body() dto: CompleteLeadDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Req() req: Request,
  ) {
    const existing = await this.leadsService.getById(id);
    if (!existing) {
      return { success: false, message: 'Lead not found.' };
    }
    const mobile = String(existing.mobile_number ?? '').trim();
    await assertLeadPiiAccess(this.otpService, mobile, {
      adminKey,
      idToken: extractIdToken(headers),
    });

    const result = await this.leadsService.completeLead(id, dto, {
      clientIp: this.clientIp(req),
    });
    if (!result.ok) {
      this.throwLeadWriteFailure(result.message || 'Failed to update details.', result.code);
    }
    return { success: true, data: this.sanitizePublicLead(result.lead) };
  }

  @Post()
  @UseGuards(MobileAccessGuard)
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateLeadDto, @Req() req: Request) {
    try {
      const existing = await this.leadsService.getByMobileAndCategory(
        dto.mobileNumber,
        dto.category || 'personal_loan',
        dto.category === 'insurance' ? dto.insType ?? null : null,
      );
      if (existing && this.leadsService.isDraftLead(existing)) {
        const updated = await this.leadsService.updateById(String(existing['id']), {
          pan: dto.pan,
          fullName: dto.fullName,
          category: dto.category,
          email: dto.email,
          pincode: dto.pincode,
          requiredAmount: dto.requiredAmount,
          loanAmt: dto.category === 'personal_loan' ? dto.loanAmt ?? null : null,
          insType: dto.category === 'insurance' ? dto.insType ?? null : null,
          employmentType:
            dto.category === 'personal_loan' ? dto.employmentType ?? null : null,
          netMonthlyIncome:
            dto.category === 'personal_loan' ? dto.netMonthlyIncome ?? null : null,
          clientIp: this.clientIp(req),
        });
        if (!updated) {
          return { success: false, message: 'Failed to update lead' };
        }
        return { success: true, data: this.sanitizePublicLead(updated) };
      }

      const lead = await this.leadsService.create(dto, { clientIp: this.clientIp(req) });
      if (!lead) {
        return { success: false, message: 'Failed to create lead' };
      }
      return { success: true, data: this.sanitizePublicLead(lead) };
    } catch (error) {
      if (error instanceof LeadRuleError) {
        return {
          success: false,
          message: error.message,
          code: error.code,
        };
      }
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsController.create', error);
      }
      return {
        success: false,
        message: error instanceof Error
          ? toPublicErrorMessage(error.message, 'Failed to create lead')
          : 'Failed to create lead',
      };
    }
  }

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
    const leads = await this.leadsService.getByUserId(userId);
    return { success: true, data: leads.map((l) => this.sanitizePublicLead(l)) };
  }

  @Get('user/:userId/category/:category')
  @HttpCode(HttpStatus.OK)
  async getByCategory(
    @Param('userId') userId: string,
    @Param('category') category: string,
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
    const leads = await this.leadsService.getByCategory(userId, category);
    return { success: true, data: leads.map((l) => this.sanitizePublicLead(l)) };
  }

  @Get('admin/all')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async getAllForAdmin() {
    const leads = await this.leadsService.getAll();
    return { success: true, data: leads };
  }

  @Get('admin/by-agent/:agentId')
  @HttpCode(HttpStatus.OK)
  async getByAgentForAdmin(
    @Param('agentId') agentId: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Headers('x-admin-internal-key') adminKey: string | undefined,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const actor = verifyAdminActor(extractAdminActorToken(headers));
    const allowed =
      isCrmAdminActor(actor) ||
      (actor?.role === 'agent' && actor.sub === agentId.trim());
    if (!allowed) {
      throw new UnauthorizedException('Unauthorized');
    }

    const leads = await this.leadsService.getByAgentId(agentId);
    return { success: true, data: leads.map((l) => this.sanitizePublicLead(l)) };
  }

  /** Always insert a new lead (admin CRM / partner panel). Does not upsert by mobile. */
  @Post('admin')
  @UseGuards(AdminPanelGuard)
  @HttpCode(HttpStatus.CREATED)
  async createForAdmin(
    @Body() dto: AdminCreateLeadDto,
    @Req() req: { adminActor?: AdminActor },
  ) {
    const actor = req.adminActor;
    const isAgent = String(actor?.role ?? '').toLowerCase() === 'agent';
    const category = dto.category || 'personal_loan';
    const insType = category === 'insurance' ? dto.insType ?? null : null;
    const gates = await this.leadsService.evaluateApplicationGates({
      mobileNumber: dto.mobileNumber,
      pan: dto.pan,
      category,
      insType,
    });
    if (!gates.allowed) {
      const isLimit = gates.code === CODE_MOBILE_PAN_LIMIT_REACHED;
      return {
        success: false,
        field: isLimit ? 'mobileNumber' : 'pan',
        message: gates.message,
        code: gates.code,
      };
    }

    const actorRole = String(actor?.role ?? '').toLowerCase();
    if (
      !isAgent &&
      String(dto.status ?? '').trim().toLowerCase() === 'approved' &&
      actorRole !== 'admin'
    ) {
      throw new HttpException(
        {
          success: false,
          message: MSG_APPROVE_ADMIN_ONLY,
          code: CODE_APPROVE_ADMIN_ONLY,
        },
        HttpStatus.FORBIDDEN,
      );
    }

    let created: Record<string, unknown> | null;
    try {
      created = await this.leadsService.create({
        pan: dto.pan,
        mobileNumber: dto.mobileNumber,
        fullName: dto.fullName,
        email: dto.email,
        pincode: dto.pincode,
        requiredAmount: dto.requiredAmount,
        category: dto.category,
        loanAmt: dto.loanAmt,
        insType: dto.insType,
        employmentType: dto.employmentType,
        netMonthlyIncome: dto.netMonthlyIncome,
      });
    } catch (err) {
      if (err instanceof LeadRuleError) {
        return {
          success: false,
          field: err.code === CODE_MOBILE_PAN_LIMIT_REACHED ? 'mobileNumber' : 'pan',
          message: err.message,
          code: err.code,
        };
      }
      throw err;
    }

    if (!created?.id) {
      return {
        success: false,
        message: 'Failed to create lead. Check PAN / mobile and try again.',
      };
    }

    let lead = created;
    const patch: {
      status?: string;
      notes?: string;
      agentId?: string;
    } = {};

    if (isAgent && actor?.sub) {
      // Partner manual lead: always attributed to them, always pending.
      patch.agentId = actor.sub;
      patch.status = 'pending';
    } else {
      if (dto.status != null) patch.status = dto.status;
      if (dto.notes !== undefined) patch.notes = dto.notes;
    }

    if (Object.keys(patch).length > 0) {
      try {
        const updated = await this.leadsService.updateById(
          String(created.id),
          patch,
          actor,
        );
        if (updated) lead = updated;
      } catch (err) {
        this.rethrowLeadMutation(err);
      }
    }

    return { success: true, data: lead };
  }

  @Patch('admin/:id')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async updateForAdmin(
    @Param('id') id: string,
    @Body() dto: UpdateLeadDto,
    @Req() req: { adminActor?: AdminActor },
  ) {
    try {
      const lead = await this.leadsService.updateById(id, dto, req.adminActor);
      if (!lead) {
        throw new NotFoundException('Lead not found or update failed');
      }
      return { success: true, data: lead };
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      this.rethrowLeadMutation(err);
    }
  }

  /**
   * Reveal full PAN for a lead. Actor identity comes from signed x-admin-actor
   * (AdminCrmGuard), never from the request body.
   */
  @Post('admin/:id/pan/reveal')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async revealPanForAdmin(
    @Param('id') id: string,
    @Body() dto: RevealPanDto,
    @Req() req: { adminActor?: AdminActor },
  ) {
    const actor = req.adminActor;
    if (!actor) {
      throw new UnauthorizedException('Unauthorized');
    }

    const rateKey = `pan-reveal:${actor.email || actor.sub}`;
    if (!allowRateLimitedAction(rateKey, 10, 60_000)) {
      throw new BadRequestException('Too many PAN reveals. Try again in a minute.');
    }

    const result = await this.leadsService.revealPan(id, {
      adminId: actor.sub,
      adminEmail: actor.email,
      adminRole: actor.role,
      ipAddress: dto.ipAddress,
      userAgent: dto.userAgent,
      reason: dto.reason ?? 'admin_panel_reveal',
    });

    if (!result.ok) {
      throw new NotFoundException(result.message);
    }

    return {
      success: true,
      pan: result.pan,
      masked: result.masked,
      revealedAt: new Date().toISOString(),
    };
  }

  @Delete('admin/:id')
  @UseGuards(AdminCrmGuard, AdminOnlyGuard)
  @HttpCode(HttpStatus.OK)
  async deleteForAdmin(@Param('id') id: string) {
    try {
      const ok = await this.leadsService.deleteById(id);
      if (!ok) {
        throw new NotFoundException('Lead not found or delete failed');
      }
      return { success: true };
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      this.rethrowLeadMutation(err);
    }
  }
}
