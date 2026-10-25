import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import {
  FALLBACK_INSURANCE_TYPES,
  FALLBACK_VEHICLE_CATEGORIES,
  INS_TYPE_SLUG_PATTERN,
  type InsuranceTypePublic,
  type VehicleCategoryPublic,
} from '../catalog/catalog';
import { TABLE_INSURANCE_TYPES, TABLE_PRODUCTS, TABLE_VEHICLE_CATEGORIES } from '../common/constants';
import { SUPABASE_CLIENT } from '../config/supabase';
import type { PublicCatalog, ServicePublic } from './services.dto';
import { AdminUpdateServiceDto } from './services.dto';

const CATALOG_TTL_MS = 60_000;
const MAX_RUPEE_LIMIT = 100_00_00_000;

function rupeeLimit(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_RUPEE_LIMIT) return null;
  return n;
}

@Injectable()
export class ServicesService {
  private catalogCache: { at: number; value: PublicCatalog } | null = null;

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  private get table() {
    return this.supabase.from(TABLE_PRODUCTS);
  }

  private invalidateCatalogCache() {
    this.catalogCache = null;
  }

  private rowToPublic(item: Record<string, unknown>): ServicePublic {
    let slug = String(item.slug ?? '');
    let title = String(item.title ?? '');
    let description = String(item.description ?? '');
    if (slug === 'car-loan') {
      slug = 'vehicle-loan';
      title = 'Vehicle Loan';
      description = description.replace(/car loan/gi, 'vehicle loan');
    }
    return {
      id: String(item.id ?? ''),
      slug,
      title,
      description,
      imageUrl: typeof item.image_url === 'string' ? item.image_url.trim() : '',
      sortOrder: (item.sort_order as number) ?? 0,
      isActive: (item.is_active as boolean) ?? true,
      limitStart: rupeeLimit(item.limit_start),
      limitEnd: rupeeLimit(item.limit_end),
      createdAt: String(item.created_at ?? ''),
      updatedAt: String(item.updated_at ?? ''),
    };
  }

  async getActivePublic(): Promise<ServicePublic[]> {
    const { data, error } = await this.table
      .select('id, slug, title, description, image_url, sort_order, is_active, limit_start, limit_end, created_at, updated_at')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error) return [];

    return (data ?? []).map((item) => this.rowToPublic(item as Record<string, unknown>));
  }

  private async fetchActiveInsuranceTypes(): Promise<InsuranceTypePublic[]> {
    const { data, error } = await this.supabase
      .from(TABLE_INSURANCE_TYPES)
      .select('slug, label, image, sort_order, is_active')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error || !data?.length) return FALLBACK_INSURANCE_TYPES.map((t) => ({ ...t }));

    const types: InsuranceTypePublic[] = [];
    for (const row of data) {
      let value = String((row as { slug?: unknown }).slug ?? '')
        .trim()
        .toLowerCase();
      let label = String((row as { label?: unknown }).label ?? '').trim();
      const image = String((row as { image?: unknown }).image ?? '').trim();
      if (value === 'car_insurance' || value === 'vehicle_insurance') {
        value = 'vehicle_insurance';
        label = 'Vehicle Insurance';
      } else if (value === 'third_party_pvt_car_insurance' || value === 'third_party_pvt_vehicle_insurance') {
        value = 'third_party_pvt_vehicle_insurance';
        label = 'Third Party Pvt Vehicle Insurance';
      }
      if (!INS_TYPE_SLUG_PATTERN.test(value) || !label) continue;
      types.push({ value, label, image });
    }
    return types.length > 0 ? types : FALLBACK_INSURANCE_TYPES.map((t) => ({ ...t }));
  }

  private async fetchVehicleCategories(): Promise<VehicleCategoryPublic[]> {
    const { data, error } = await this.supabase
      .from(TABLE_VEHICLE_CATEGORIES)
      .select('slug, label, image, sort_order, is_active')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error || !data?.length) return FALLBACK_VEHICLE_CATEGORIES.map((row) => ({ ...row }));

    const types: VehicleCategoryPublic[] = [];
    for (const row of data) {
      const value = String((row as { slug?: unknown }).slug ?? '')
        .trim()
        .toLowerCase();
      const label = String((row as { label?: unknown }).label ?? '').trim();
      const image = String((row as { image?: unknown }).image ?? '').trim();
      if (!INS_TYPE_SLUG_PATTERN.test(value) || !label) continue;
      types.push({ value, label, image });
    }
    return types.length > 0 ? types : FALLBACK_VEHICLE_CATEGORIES.map((row) => ({ ...row }));
  }

  async resolveVehicleCategory(slug?: string | null): Promise<string | null> {
    const value = String(slug ?? '')
      .trim()
      .toLowerCase();
    if (!INS_TYPE_SLUG_PATTERN.test(value)) return null;
    const list = await this.fetchVehicleCategories();
    return list.some((row) => row.value === value) ? value : null;
  }

  /** Loan rows for the /products/loans tabs. Active flag does not hide them. */
  private async fetchLoanProducts(): Promise<ServicePublic[]> {
    const { data, error } = await this.table
      .select('id, slug, title, description, image_url, sort_order, is_active, limit_start, limit_end, created_at, updated_at')
      .ilike('slug', '%-loan')
      .order('sort_order', { ascending: true });

    if (error || !data) return [];
    return (data as Record<string, unknown>[])
      .map((item) => this.rowToPublic(item))
      .filter((row) => /^[a-z0-9]+(?:-[a-z0-9]+)*-loan$/.test(row.slug));
  }

  async getPublicCatalog(): Promise<PublicCatalog> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < CATALOG_TTL_MS) {
      return this.catalogCache.value;
    }
    const [services, insuranceTypes, vehicleCategories, loanProducts] = await Promise.all([
      this.getActivePublic(),
      this.fetchActiveInsuranceTypes(),
      this.fetchVehicleCategories(),
      this.fetchLoanProducts(),
    ]);
    const value = { services, insuranceTypes, vehicleCategories, loanProducts };
    this.catalogCache = { at: Date.now(), value };
    return value;
  }

  async amountBoundsBySlug(slug: string): Promise<{ min: number; max: number } | null> {
    const key = slug.trim().toLowerCase();
    if (!key) return null;
    const keys = key === 'vehicle-loan' || key === 'car-loan' ? ['vehicle-loan', 'car-loan'] : [key];
    for (const candidate of keys) {
      const { data, error } = await this.table
        .select('limit_start, limit_end')
        .eq('slug', candidate)
        .maybeSingle();
      if (error || !data) continue;
      const row = data as { limit_start?: unknown; limit_end?: unknown };
      const min = rupeeLimit(row.limit_start);
      const max = rupeeLimit(row.limit_end);
      if (min == null || max == null || max < min) continue;
      return { min, max };
    }
    return null;
  }

  /** Vehicle Insurance keeps working while the database slug is still car_insurance. */
  async resolveInsuranceTypeSlug(slug: string): Promise<string | null> {
    const t = slug.trim().toLowerCase();
    if (!INS_TYPE_SLUG_PATTERN.test(t)) return null;
    const aliases: Record<string, string[]> = {
      car_insurance: ['vehicle_insurance', 'car_insurance'],
      vehicle_insurance: ['vehicle_insurance', 'car_insurance'],
      third_party_pvt_car_insurance: ['third_party_pvt_vehicle_insurance', 'third_party_pvt_car_insurance'],
      third_party_pvt_vehicle_insurance: ['third_party_pvt_vehicle_insurance', 'third_party_pvt_car_insurance'],
    };
    const candidates = aliases[t] ?? [t];
    const { data, error } = await this.supabase
      .from(TABLE_INSURANCE_TYPES)
      .select('slug')
      .in('slug', candidates)
      .eq('is_active', true);
    if (!error && data?.length) {
      const have = new Set(data.map((row) => String((row as { slug?: string }).slug ?? '')));
      for (const candidate of candidates) {
        if (have.has(candidate)) return candidate;
      }
    }
    if (error) {
      const known = new Set(FALLBACK_INSURANCE_TYPES.map((row) => row.value));
      for (const candidate of candidates) {
        if (known.has(candidate)) return candidate;
      }
    }
    return null;
  }

  async isAllowedInsuranceType(slug: string): Promise<boolean> {
    return (await this.resolveInsuranceTypeSlug(slug)) != null;
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
    if (dto.limitStart !== undefined) payload.limit_start = dto.limitStart;
    if (dto.limitEnd !== undefined) payload.limit_end = dto.limitEnd;
    if (dto.limitStart !== undefined || dto.limitEnd !== undefined) {
      await this.assertLimitRange(id, dto.limitStart, dto.limitEnd);
    }

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

  private async assertLimitRange(
    id: string,
    nextStart: number | null | undefined,
    nextEnd: number | null | undefined,
  ) {
    const { data } = await this.table.select('limit_start, limit_end').eq('id', id).maybeSingle();
    const current = (data ?? {}) as { limit_start?: unknown; limit_end?: unknown };
    const start = nextStart !== undefined ? nextStart : rupeeLimit(current.limit_start);
    const end = nextEnd !== undefined ? nextEnd : rupeeLimit(current.limit_end);
    const empty = start == null && end == null;
    const pair = start != null && end != null && end >= start;
    if (!empty && !pair) {
      throw new BadRequestException('Set both limit start and limit end, and keep end at or above start.');
    }
  }
}
