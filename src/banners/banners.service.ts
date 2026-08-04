import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../config/supabase';
import { TABLE_BANNERS } from '../common/constants';
import type { BannerPublic } from './banners.types';

@Injectable()
export class BannersService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  private get banners() {
    return this.supabase.from(TABLE_BANNERS);
  }

  private mapToResponseDto(data: Record<string, unknown>[]): BannerPublic[] {
    return data.map((item) => ({
      id: item.id as string,
      imageUrl: typeof item.image_url === 'string' ? (item.image_url as string).trim() : '',
      title: item.title as string | undefined,
      description: item.description as string | undefined,
      category: (item.category as string) || 'carousel',
      displayOrder: (item.display_order as number) || 0,
      actionUrl: item.action_url as string | undefined,
      actionType: item.action_type as string | undefined,
      isActive: (item.is_active as boolean) ?? true,
      createdAt: item.created_at as string,
      updatedAt: item.updated_at as string,
    }));
  }

  async getAllActive(): Promise<BannerPublic[]> {
    const { data, error } = await this.banners
      .select()
      .eq('is_active', true)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: false });

    if (error) return [];
    return this.mapToResponseDto(data || []);
  }

  async getByCategory(category: string): Promise<BannerPublic[]> {
    const normalizedCategory = category.toLowerCase().trim();

    let { data, error } = await this.banners
      .select()
      .eq('is_active', true)
      .eq('category', normalizedCategory)
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: false });

    if (!error && (!data || data.length === 0)) {
      const { data: allData, error: allError } = await this.banners
        .select()
        .eq('is_active', true)
        .order('display_order', { ascending: true })
        .order('created_at', { ascending: false });

      if (!allError && allData) {
        data = allData.filter(
          (row) => (row.category as string)?.toLowerCase() === normalizedCategory,
        );
        error = null;
      }
    }

    if (error) return [];
    return this.mapToResponseDto(data || []);
  }

  async getAll(): Promise<BannerPublic[]> {
    const { data, error } = await this.banners
      .select()
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: false });

    if (error) return [];
    return this.mapToResponseDto(data || []);
  }
}
