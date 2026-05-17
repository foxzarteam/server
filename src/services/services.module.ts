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
  Module,
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

class AdminUpdateServiceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  slug?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

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

@Module({
  controllers: [ServicesController],
  providers: [ServicesService],
})
export class ServicesModule {}
