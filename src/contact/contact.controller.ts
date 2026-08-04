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
  BadRequestException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MinLength,
} from 'class-validator';
import { adminInternalKeyOk } from '../common/admin-internal';
import { TABLE_CONTACT } from '../common/constants';
import { SUPABASE_CLIENT } from '../config/supabase';

import {
  CreateContactDto,
  UpdateContactDto,
} from './contact.dto';
import { ContactService } from './contact.service';

@Controller('contact')
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  /** Public contact form submit. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateContactDto) {
    const row = await this.contactService.create(dto);
    if (!row) {
      throw new BadRequestException('Could not save your message.');
    }
    return { success: true, id: row.id };
  }

  @Get('admin/all')
  @HttpCode(HttpStatus.OK)
  async getAllForAdmin(@Headers('x-admin-internal-key') adminKey: string | undefined) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const data = await this.contactService.getAll();
    return { success: true, data };
  }

  @Patch('admin/:id')
  @HttpCode(HttpStatus.OK)
  async updateForAdmin(
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdateContactDto,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const data = await this.contactService.updateById(id, dto);
    if (!data) {
      throw new NotFoundException('Contact not found or update failed');
    }
    return { success: true, data };
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
    const ok = await this.contactService.deleteById(id);
    if (!ok) {
      throw new NotFoundException('Contact not found or delete failed');
    }
    return { success: true };
  }
}
