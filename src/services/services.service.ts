import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import {
  FALLBACK_INSURANCE_TYPES,
  INS_TYPE_SLUG_PATTERN,
  type InsuranceTypePublic,
} from '../catalog/catalog';
import { TABLE_INSURANCE_TYPES, TABLE_SERVICES } from '../common/constants';
import { SUPABASE_CLIENT } from '../config/supabase';
import type { PublicCatalog, ServicePublic } from './services.dto';
import { AdminUpdateServiceDto } from './services.dto';

const CATALOG_TTL_MS = 60_000;

@Injectable()
export class ServicesService {
  private catalogCache: { at: number; value: PublicCatalog } | null = null;

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  private get table() {
    return this.supabase.from(TABLE_SERVICES);
  }

  private invalidateCatalogCache() {
    this.catalogCache = null;
  }

  private rowToPublic(item: Record<string, unknown>): ServicePublic {
    return {
      id: String(item.id ?? ''),
      slug: String(item.slug ?? ''),
      title: String(item.title ?? ''),
      description: String(item.description ?? ''),
      imageUrl: typeof item.image_url === 'string' ? item.image_url.trim() : '',
      sortOrder: (item.sort_order as number) ?? 0,
      isActive: (item.is_active as boolean) ?? true,
      createdAt: String(item.created_at ?? ''),
      updatedAt: String(item.updated_at ?? ''),
    };
  }

  async getActivePublic(): Promise<ServicePublic[]> {
    const { data, error } = await this.table
      .select('id, slug, title, description, image_url, sort_order, is_active, created_at, updated_at')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error) return [];

    return (data ?? []).map((item) => this.rowToPublic(item as Record<string, unknown>));
  }

  private async fetchActiveInsuranceTypes(): Promise<InsuranceTypePublic[]> {
    const { data, error } = await this.supabase
      .from(TABLE_INSURANCE_TYPES)
      .select('slug, label, sort_order, is_active')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error || !data?.length) return FALLBACK_INSURANCE_TYPES.map((t) => ({ ...t }));

    const types: InsuranceTypePublic[] = [];
    for (const row of data) {
      const value = String((row as { slug?: unknown }).slug ?? '')
        .trim()
        .toLowerCase();
      const label = String((row as { label?: unknown }).label ?? '').trim();
      if (!INS_TYPE_SLUG_PATTERN.test(value) || !label) continue;
      types.push({ value, label });
    }
    return types.length > 0 ? types : FALLBACK_INSURANCE_TYPES.map((t) => ({ ...t }));
  }

  async getPublicCatalog(): Promise<PublicCatalog> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < CATALOG_TTL_MS) {
      return this.catalogCache.value;
    }
    const [services, insuranceTypes] = await Promise.all([
      this.getActivePublic(),
      this.fetchActiveInsuranceTypes(),
    ]);
    const value = { services, insuranceTypes };
    this.catalogCache = { at: Date.now(), value };
    return value;
  }

  async isAllowedInsuranceType(slug: string): Promise<boolean> {
    const t = slug.trim().toLowerCase();
    if (!INS_TYPE_SLUG_PATTERN.test(t)) return false;
    const types = await this.fetchActiveInsuranceTypes();
    return types.some((x) => x.value === t);
  }

  async getAll(): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.table.select().order('sort_order', { ascending: true });

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('ServicesService.getAll', error);
      }
      return [];
    }

    return (data as Record<string, unknown>[]) || [];
  }

  async updateById(id: string, dto: AdminUpdateServiceDto): Promise<Record<string, unknown> | null> {
    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (dto.title != null) payload.title = dto.title.trim();
    if (dto.slug != null) payload.slug = dto.slug.trim().toLowerCase().replace(/\s+/g, '-');
    if (dto.description != null) payload.description = dto.description.trim();
    if (dto.imageUrl != null) payload.image_url = dto.imageUrl.trim();
    if (dto.sortOrder != null) payload.sort_order = dto.sortOrder;
    if (dto.isActive != null) payload.is_active = dto.isActive;

    if (Object.keys(payload).length === 1) return null;

    const { data, error } = await this.table.update(payload).eq('id', id).select().single();
    this.invalidateCatalogCache();

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('ServicesService.updateById', error);
      }
      return null;
    }

    return data as Record<string, unknown>;
  }

  async deleteById(id: string): Promise<boolean> {
    const { error } = await this.table.delete().eq('id', id);
    this.invalidateCatalogCache();

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('ServicesService.deleteById', error);
      }
      return false;
    }

    return true;
  }
}
