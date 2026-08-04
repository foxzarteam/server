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
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { IsBoolean, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { adminInternalKeyOk } from '../common/admin-internal';
import { TABLE_SERVICES } from '../common/constants';
import { SUPABASE_CLIENT } from '../config/supabase';

import {
  AdminUpdateServiceDto,
} from './services.dto';
import { ServicesService } from './services.service';

@Controller('services')
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Get('admin/all')
  @HttpCode(HttpStatus.OK)
  async getAllForAdmin(@Headers('x-admin-internal-key') adminKey: string | undefined) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const services = await this.servicesService.getAll();
    return { success: true, data: services };
  }

  @Patch('admin/:id')
  @HttpCode(HttpStatus.OK)
  async updateForAdmin(
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Param('id') id: string,
    @Body() dto: AdminUpdateServiceDto,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const service = await this.servicesService.updateById(id, dto);
    if (!service) {
      throw new NotFoundException('Service not found or update failed');
    }
    return { success: true, data: service };
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
    const ok = await this.servicesService.deleteById(id);
    if (!ok) {
      throw new NotFoundException('Service not found or delete failed');
    }
    return { success: true };
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  async getActive() {
    const services = await this.servicesService.getActivePublic();
    return { success: true, data: services };
  }
}
