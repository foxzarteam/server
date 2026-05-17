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
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { IsIn, IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { adminInternalKeyOk } from '../common/admin-internal';
import { TABLE_PARTNER, TABLE_SERVICES } from '../common/constants';
import { SUPABASE_CLIENT } from '../config/supabase';

class AdminCreatePartnerDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsString()
  @MinLength(1)
  serviceId: string;

  @IsString()
  @IsIn(['PERCENTAGE', 'FLAT'], { message: 'payoutType must be PERCENTAGE or FLAT' })
  payoutType: string;

  @IsNumber()
  @Min(0)
  commissionValue: number;
}

class AdminUpdatePartnerDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  serviceId?: string;

  @IsOptional()
  @IsString()
  @IsIn(['PERCENTAGE', 'FLAT'], { message: 'payoutType must be PERCENTAGE or FLAT' })
  payoutType?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  commissionValue?: number;
}

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

@Controller('partners')
export class PartnerController {
  constructor(private readonly partnerService: PartnerService) {}

  @Get('admin/all')
  @HttpCode(HttpStatus.OK)
  async getAllForAdmin(@Headers('x-admin-internal-key') adminKey: string | undefined) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const data = await this.partnerService.getAll();
    return { success: true, data };
  }

  @Post('admin')
  @HttpCode(HttpStatus.CREATED)
  async createForAdmin(
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Body() dto: AdminCreatePartnerDto,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const row = await this.partnerService.create(dto);
    if (!row) {
      throw new NotFoundException('Failed to create partner');
    }
    return { success: true, data: row };
  }

  @Patch('admin/:id')
  @HttpCode(HttpStatus.OK)
  async updateForAdmin(
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Param('id') id: string,
    @Body() dto: AdminUpdatePartnerDto,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const row = await this.partnerService.updateById(id, dto);
    if (!row) {
      throw new NotFoundException('Partner not found or update failed');
    }
    return { success: true, data: row };
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
    const ok = await this.partnerService.deleteById(id);
    if (!ok) {
      throw new NotFoundException('Partner not found or delete failed');
    }
    return { success: true };
  }
}

@Module({
  controllers: [PartnerController],
  providers: [PartnerService],
})
export class PartnerModule {}
