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
  ConflictException,
  BadRequestException,
  UseGuards,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { adminInternalKeyOk } from '../common/admin-internal';
import { AdminInternalGuard } from '../common/admin-internal.guard';
import { MobileAccessGuard } from '../common/mobile-access.guard';
import { assertMobileAccess, extractIdToken } from '../common/phone-access';
import { MSG_OTP_PHONE_NOT_VERIFIED } from '../common/constants';
import { OtpService } from '../otp/otp.service';
import { UsersService } from '../users/users.service';
import { sanitizePublicLead } from '../security/pan-crypto';
import { allowRateLimitedAction } from '../security/rate-limit';
import { extractClientIp } from '../common/client-ip';
import {
  AdminCreateLeadDto,
  CompleteLeadDto,
  CreateLeadDto,
  RevealPanDto,
  StartLeadDto,
  UpdateLeadDto,
} from './leads.dto';
import { LeadsService } from './leads.service';

@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leadsService: LeadsService,
    private readonly otpService: OtpService,
    private readonly usersService: UsersService,
  ) {}

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
   * Public apply: save lead BEFORE OTP.
   * Same mobile/PAN allowed once per product category.
   */
  @Post('apply')
  @HttpCode(HttpStatus.CREATED)
  async apply(@Body() dto: CreateLeadDto, @Req() req: Request) {
    const mobile = dto.mobileNumber?.trim() ?? '';
    if (mobile && !allowRateLimitedAction(`lead-apply:${mobile}`, 8, 60_000)) {
      throw new BadRequestException('Too many applications. Please try again in a minute.');
    }

    const result = await this.leadsService.applyLead(dto, {
      clientIp: this.clientIp(req),
    });
    if (!result.ok || !result.lead) {
      const message = result.message || 'Failed to create lead';
      if (
        message.toLowerCase().includes('already') ||
        message.toLowerCase().includes('already have')
      ) {
        throw new ConflictException(message);
      }
      throw new BadRequestException(message);
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
    await assertMobileAccess(this.otpService, mobile, {
      adminKey,
      idToken: extractIdToken(headers),
    });

    const result = await this.leadsService.completeLead(id, dto, {
      clientIp: this.clientIp(req),
    });
    if (!result.ok) {
      const message = result.message || 'Failed to update details.';
      if (
        message.toLowerCase().includes('already') ||
        message.toLowerCase().includes('already have')
      ) {
        throw new ConflictException(message);
      }
      throw new BadRequestException(message);
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
      );
      if (existing) {
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
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsController.create', error);
      }
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to create lead',
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
  @UseGuards(AdminInternalGuard)
  @HttpCode(HttpStatus.OK)
  async getAllForAdmin() {
    const leads = await this.leadsService.getAll();
    return { success: true, data: leads };
  }

  @Get('admin/by-agent/:agentId')
  @UseGuards(AdminInternalGuard)
  @HttpCode(HttpStatus.OK)
  async getByAgentForAdmin(@Param('agentId') agentId: string) {
    const leads = await this.leadsService.getByAgentId(agentId);
    return { success: true, data: leads.map((l) => this.sanitizePublicLead(l)) };
  }

  /** Always insert a new lead (admin CRM). Does not upsert by mobile. */
  @Post('admin')
  @UseGuards(AdminInternalGuard)
  @HttpCode(HttpStatus.CREATED)
  async createForAdmin(@Body() dto: AdminCreateLeadDto) {
    const category = dto.category || 'personal_loan';
    const [byMobile, byPan] = await Promise.all([
      this.leadsService.getByMobileAndCategory(dto.mobileNumber, category),
      this.leadsService.getByPanAndCategory(dto.pan, category),
    ]);
    if (byMobile && !this.leadsService.isDraftLead(byMobile)) {
      return {
        success: false,
        field: 'mobileNumber',
        message: 'A lead with this phone number already exists for this product',
      };
    }
    if (
      byPan &&
      !this.leadsService.isDraftLead(byPan) &&
      String(byPan.id) !== String(byMobile?.id ?? '')
    ) {
      return {
        success: false,
        field: 'pan',
        message: 'A lead with this PAN already exists for this product',
      };
    }

    const created = await this.leadsService.create({
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

    if (!created?.id) {
      return {
        success: false,
        message: 'Failed to create lead. Check PAN / mobile and try again.',
      };
    }

    let lead = created;
    if (dto.status != null || dto.notes !== undefined) {
      const updated = await this.leadsService.updateById(String(created.id), {
        status: dto.status,
        notes: dto.notes,
      });
      if (updated) lead = updated;
    }

    return { success: true, data: lead };
  }

  @Patch('admin/:id')
  @UseGuards(AdminInternalGuard)
  @HttpCode(HttpStatus.OK)
  async updateForAdmin(@Param('id') id: string, @Body() dto: UpdateLeadDto) {
    const lead = await this.leadsService.updateById(id, dto);
    if (!lead) {
      throw new NotFoundException('Lead not found or update failed');
    }
    return { success: true, data: lead };
  }

  /**
   * Reveal full PAN for a lead. Requires admin internal key.
   * Every call is written to pan_access_audit with admin identity + timestamp.
   */
  @Post('admin/:id/pan/reveal')
  @UseGuards(AdminInternalGuard)
  @HttpCode(HttpStatus.OK)
  async revealPanForAdmin(@Param('id') id: string, @Body() dto: RevealPanDto) {
    if (!dto.adminEmail?.trim() && !dto.adminId?.trim()) {
      throw new BadRequestException('Admin identity is required for PAN reveal');
    }
    const role = String(dto.adminRole ?? '').trim().toLowerCase();
    if (role !== 'admin' && role !== 'staff') {
      throw new UnauthorizedException('Insufficient role for PAN reveal');
    }

    const rateKey = `pan-reveal:${dto.adminEmail || dto.adminId}`;
    if (!allowRateLimitedAction(rateKey, 10, 60_000)) {
      throw new BadRequestException('Too many PAN reveals. Try again in a minute.');
    }

    const result = await this.leadsService.revealPan(id, {
      adminId: dto.adminId,
      adminEmail: dto.adminEmail,
      adminRole: dto.adminRole,
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
  @UseGuards(AdminInternalGuard)
  @HttpCode(HttpStatus.OK)
  async deleteForAdmin(@Param('id') id: string) {
    const ok = await this.leadsService.deleteById(id);
    if (!ok) {
      throw new NotFoundException('Lead not found or delete failed');
    }
    return { success: true };
  }
}
