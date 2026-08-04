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

@Injectable()
export class PartnerService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  private get table() {
    return this.supabase.from(TABLE_PARTNER);
  }

  private normalizeServiceId(raw: string): string {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .join(',');
  }

  private async loadSortOrderTitleMap(): Promise<Map<number, string>> {
    const { data, error } = await this.supabase
      .from(TABLE_SERVICES)
      .select('sort_order, title');

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('PartnerService.loadSortOrderTitleMap', error);
      }
      return new Map();
    }

    const map = new Map<number, string>();
    for (const row of data ?? []) {
      const order = Number(row.sort_order);
      if (Number.isFinite(order)) {
        map.set(order, String(row.title ?? '').trim() || `Service ${order}`);
      }
    }
    return map;
  }

  private resolveServiceNames(serviceIdCsv: string, titleBySortOrder: Map<number, string>): string {
    const parts = serviceIdCsv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return '';

    return parts
      .map((part) => {
        const order = Number(part);
        if (!Number.isFinite(order)) return part;
        return titleBySortOrder.get(order) ?? `Unknown (sort ${order})`;
      })
      .join(', ');
  }

  private async enrichRow(row: Record<string, unknown>, titleBySortOrder?: Map<number, string>) {
    const map = titleBySortOrder ?? (await this.loadSortOrderTitleMap());
    const serviceId = String(row.service_id ?? '');
    return {
      ...row,
      service_names: this.resolveServiceNames(serviceId, map),
    };
  }

  private async enrichRows(rows: Record<string, unknown>[]) {
    const map = await this.loadSortOrderTitleMap();
    return Promise.all(rows.map((row) => this.enrichRow(row, map)));
  }

  async getAll(): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.table.select().order('created_at', { ascending: false });

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('PartnerService.getAll', error);
      }
      return [];
    }

    const rows = (data as Record<string, unknown>[]) || [];
    return this.enrichRows(rows);
  }

  async create(dto: AdminCreatePartnerDto): Promise<Record<string, unknown> | null> {
    const payload = {
      name: dto.name.trim(),
      service_id: this.normalizeServiceId(dto.serviceId),
      payout_type: dto.payoutType,
      commission_value: dto.commissionValue,
    };

    const { data, error } = await this.table.insert(payload).select().single();

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('PartnerService.create', error);
      }
      return null;
    }

    return this.enrichRow(data as Record<string, unknown>);
  }

  async updateById(id: string, dto: AdminUpdatePartnerDto): Promise<Record<string, unknown> | null> {
    const payload: Record<string, unknown> = {};

    if (dto.name != null) payload.name = dto.name.trim();
    if (dto.serviceId != null) payload.service_id = this.normalizeServiceId(dto.serviceId);
    if (dto.payoutType != null) payload.payout_type = dto.payoutType;
    if (dto.commissionValue != null) payload.commission_value = dto.commissionValue;

    if (Object.keys(payload).length === 0) return null;

    const { data, error } = await this.table.update(payload).eq('id', id).select().single();

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('PartnerService.updateById', error);
      }
      return null;
    }

    return this.enrichRow(data as Record<string, unknown>);
  }

  async deleteById(id: string): Promise<boolean> {
    const { error } = await this.table.delete().eq('id', id);

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('PartnerService.deleteById', error);
      }
      return false;
    }

    return true;
  }
}
