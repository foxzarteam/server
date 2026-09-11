import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  BadRequestException,
  UseGuards,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminCrmGuard, AdminOnlyGuard } from '../common/admin-crm.guard';
import { allowRateLimitedAction } from '../security/rate-limit';
import { CreateContactDto, TaxCalculatorLeadDto, UpdateContactDto } from './contact.dto';
import { ContactService } from './contact.service';

function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0]?.trim() || 'unknown';
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return String(forwarded[0]).split(',')[0]?.trim() || 'unknown';
  }
  return req.ip || 'unknown';
}

@Controller('contact')
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  /** Public contact form submit. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateContactDto) {
    const emailKey = (dto.email ?? 'anon').trim().toLowerCase().slice(0, 80);
    if (!allowRateLimitedAction(`contact:${emailKey}`, 5, 60_000)) {
      throw new BadRequestException('Too many messages. Please try again in a minute.');
    }
    const row = await this.contactService.create(dto);
    if (!row) {
      throw new BadRequestException('Could not save your message.');
    }
    return { success: true, id: row.id };
  }

  /**
   * Tax saving calculator lead (name + phone).
   * Message hardcoded on server. Same phone never inserts twice.
   * Always returns success after valid input (silent UX on frontend).
   */
  @Post('tax-calculator-lead')
  @HttpCode(HttpStatus.OK)
  async createTaxCalculatorLead(@Body() dto: TaxCalculatorLeadDto, @Req() req: Request) {
    const phoneKey = dto.phone.replace(/\D/g, '').slice(0, 10);
    const ip = clientIp(req);

    // Silent throttle — still return success so the UI reveals nothing
    if (
      !allowRateLimitedAction(`tax-calc-lead:${phoneKey}`, 3, 60_000) ||
      !allowRateLimitedAction(`tax-calc-lead-ip:${ip}`, 20, 60_000)
    ) {
      return { success: true };
    }

    await this.contactService.createTaxCalculatorLead({
      name: dto.name,
      phone: phoneKey,
    });
    return { success: true };
  }

  @Get('admin/all')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async getAllForAdmin() {
    const data = await this.contactService.getAll();
    return { success: true, data };
  }

  @Patch('admin/:id')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async updateForAdmin(@Param('id') id: string, @Body() dto: UpdateContactDto) {
    const data = await this.contactService.updateById(id, dto);
    if (!data) {
      throw new NotFoundException('Contact not found or update failed');
    }
    return { success: true, data };
  }

  @Delete('admin/:id')
  @UseGuards(AdminCrmGuard, AdminOnlyGuard)
  @HttpCode(HttpStatus.OK)
  async deleteForAdmin(@Param('id') id: string) {
    const ok = await this.contactService.deleteById(id);
    if (!ok) {
      throw new NotFoundException('Contact not found or delete failed');
    }
    return { success: true };
  }
}
