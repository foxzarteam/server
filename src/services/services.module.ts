import { Controller, Get, HttpCode, HttpStatus, Inject, Injectable, Module } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../config/supabase';
import { TABLE_SERVICES } from '../common/constants';

type ServicePublic = {
  id: string;
  slug: string;
  title: string;
  description: string;
  imageUrl: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

@Injectable()
export class ServicesService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  async getActivePublic(): Promise<ServicePublic[]> {
    const { data, error } = await this.supabase
      .from(TABLE_SERVICES)
      .select('id, slug, title, description, image_url, sort_order, is_active, created_at, updated_at')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error) return [];

    return (data ?? []).map((item) => ({
      id: item.id as string,
      slug: (item.slug as string) ?? '',
      title: (item.title as string) ?? '',
      description: (item.description as string) ?? '',
      imageUrl: typeof item.image_url === 'string' ? (item.image_url as string).trim() : '',
      sortOrder: (item.sort_order as number) ?? 0,
      isActive: (item.is_active as boolean) ?? true,
      createdAt: item.created_at as string,
      updatedAt: item.updated_at as string,
    }));
  }
}

@Controller('services')
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async getActive() {
    const services = await this.servicesService.getActivePublic();
    return { success: true, data: services };
  }
}

@Module({
  controllers: [ServicesController],
  providers: [ServicesService],
})
export class ServicesModule {}
