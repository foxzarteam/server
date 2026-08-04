import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { IsIn, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { adminInternalKeyOk } from '../common/admin-internal';
import { TABLE_PARTNER, TABLE_SERVICES } from '../common/constants';
import { SUPABASE_CLIENT } from '../config/supabase';

import {
  AdminCreatePartnerDto,
  AdminUpdatePartnerDto,
} from './partner.dto';
import { PartnerService } from './partner.service';

@Controller('partners')
export class PartnerController {
  constructor(private readonly partnerService: PartnerService) {}

  @Get('admin/all')
  @HttpCode(HttpStatus.OK)
  async getAllForAdmin(@Headers('x-admin-internal-key') adminKey: string | undefined) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const data = await this.partnerService.getAll();
    return { success: true, data };
  }

  @Post('admin')
  @HttpCode(HttpStatus.CREATED)
  async createForAdmin(
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Body() dto: AdminCreatePartnerDto,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const row = await this.partnerService.create(dto);
    if (!row) {
      throw new NotFoundException('Failed to create partner');
    }
    return { success: true, data: row };
  }

  @Patch('admin/:id')
  @HttpCode(HttpStatus.OK)
  async updateForAdmin(
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Param('id') id: string,
    @Body() dto: AdminUpdatePartnerDto,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const row = await this.partnerService.updateById(id, dto);
    if (!row) {
      throw new NotFoundException('Partner not found or update failed');
    }
    return { success: true, data: row };
  }

  @Delete('admin/:id')
  @HttpCode(HttpStatus.OK)
  async deleteForAdmin(
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Param('id') id: string,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const ok = await this.partnerService.deleteById(id);
    if (!ok) {
      throw new NotFoundException('Partner not found or delete failed');
    }
    return { success: true };
  }
}
