import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { TABLE_SERVICES } from '../common/constants';
import { SUPABASE_CLIENT } from '../config/supabase';
import type { ServicePublic } from './services.dto';
import { AdminUpdateServiceDto } from './services.dto';

@Injectable()
export class ServicesService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  private get table() {
    return this.supabase.from(TABLE_SERVICES);
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

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('ServicesService.deleteById', error);
      }
      return false;
    }

    return true;
  }
}
