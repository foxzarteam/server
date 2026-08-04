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

@Injectable()
export class ContactService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  private get table() {
    return this.supabase.from(TABLE_CONTACT);
  }

  async create(dto: CreateContactDto): Promise<{ id: string } | null> {
    const { data, error } = await this.table
      .insert({
        name: dto.name.trim(),
        email: dto.email.trim().toLowerCase(),
        phone: dto.phone.trim(),
        message: dto.message.trim(),
        status: 'new',
        updated_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error || !data) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('ContactService.create', error);
      }
      return null;
    }
    return { id: String((data as { id: string }).id) };
  }

  async getAll(): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.table
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('ContactService.getAll', error);
      }
      return [];
    }
    return (data as Record<string, unknown>[]) || [];
  }

  async updateById(
    id: string,
    dto: UpdateContactDto,
  ): Promise<Record<string, unknown> | null> {
    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (dto.name != null) payload.name = dto.name.trim();
    if (dto.email != null) payload.email = dto.email.trim().toLowerCase();
    if (dto.phone != null) payload.phone = dto.phone.trim();
    if (dto.message != null) payload.message = dto.message.trim();
    if (dto.status != null) payload.status = dto.status;

    if (Object.keys(payload).length <= 1) return null;

    const { data, error } = await this.table.update(payload).eq('id', id).select('*').single();
    if (error || !data) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('ContactService.updateById', error);
      }
      return null;
    }
    return data as Record<string, unknown>;
  }

  async deleteById(id: string): Promise<boolean> {
    const { error } = await this.table.delete().eq('id', id);
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('ContactService.deleteById', error);
      }
      return false;
    }
    return true;
  }
}
