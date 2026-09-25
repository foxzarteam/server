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
import { sanitizePublicLead } from '../security/pan-crypto';
import { allowRateLimitedAction } from '../security/rate-limit';
import { extractClientIp } from '../common/client-ip';
import {
  AdminCreateLeadDto,
  CreateLeadDto,
  RevealPanDto,
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
  constructor(private readonly leadsService: LeadsService) {}

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

  private clientIp(req: Request, bodyIp?: string | null): string | null {
    return extractClientIp(
      req.headers as Record<string, string | string[] | undefined>,
      req.ip ?? req.socket?.remoteAddress,
      bodyIp,
    );
  }

  /**
   * Public apply: persist the lead on form submit (Verified = No).
   * OTP is a later step — verify-firebase marks Verified = Yes.
   * Gate 1: max 4 unique PANs per mobile. Gate 2: same PAN + product unless approved.
   */
  @Post('apply')
  @HttpCode(HttpStatus.CREATED)
  async apply(
    @Body() dto: CreateLeadDto,
    @Req() req: Request,
  ) {
    const mobile = dto.mobileNumber?.trim() ?? '';
    const ip = this.clientIp(req, dto.clientIp) || 'unknown';
    if (
      (mobile && !allowRateLimitedAction(`lead-apply:${mobile}`, 8, 60_000)) ||
      !allowRateLimitedAction(`lead-apply-ip:${ip}`, 20, 60_000)
    ) {
      throw new BadRequestException('Too many applications. Please try again in a minute.');
    }

    const result = await this.leadsService.applyLead(dto, {
      clientIp: this.clientIp(req, dto.clientIp),
    });
    if (!result.ok || !result.lead) {
      this.throwLeadWriteFailure(result.message || 'Failed to create lead', result.code);
    }
    return { success: true, data: this.sanitizePublicLead(result.lead) };
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
    // Masked PAN only (ABCDE****F). Never strip the field — partners need it in view.
    return { success: true, data: leads };
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

    return { success: true, data: { ...lead, otp_verified: true } };
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
