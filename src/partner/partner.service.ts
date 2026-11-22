import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { TABLE_PARTNER, TABLE_PRODUCTS } from '../common/constants';
import { SUPABASE_CLIENT } from '../config/supabase';
import { r2GetObject, r2PublicBaseUrl, r2PutObject } from '../storage/r2';

import {
  AdminCreatePartnerDto,
  AdminUpdatePartnerDto,
} from './partner.dto';
import { normalizePartnerDocuments } from './partner-documents';

const LOGO_PREFIX = 'aggregators/';
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_FILE_RE = /^[A-Za-z0-9._-]+\.(jpe?g|png|webp|gif)$/i;

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

  private normalizeUtmLink(raw: unknown): string {
    return String(raw ?? '').trim().slice(0, 2000);
  }

  private normalizeImagePath(raw: unknown): string {
    const value = String(raw ?? '').trim();
    if (!value) return '';
    if (/^\/images\/aggregators\/[A-Za-z0-9._-]+$/.test(value)) return value;
    if (value.startsWith(LOGO_PREFIX) && LOGO_FILE_RE.test(value.slice(LOGO_PREFIX.length))) return value;
    const publicBase = r2PublicBaseUrl();
    if (publicBase && value.startsWith(`${publicBase}/${LOGO_PREFIX}`)) {
      try {
        const url = new URL(value);
        if (url.protocol === 'https:') return value.slice(0, 500);
      } catch {
        return '';
      }
    }
    return '';
  }

  private logoExt(file: { mimetype?: string; originalname?: string; buffer?: Buffer }): string | null {
    const mime = String(file.mimetype ?? '').toLowerCase();
    if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
    if (mime === 'image/png') return 'png';
    if (mime === 'image/webp') return 'webp';
    if (mime === 'image/gif') return 'gif';
    const name = String(file.originalname ?? '').toLowerCase();
    if (/\.jpe?g$/.test(name)) return 'jpg';
    if (name.endsWith('.png')) return 'png';
    if (name.endsWith('.webp')) return 'webp';
    if (name.endsWith('.gif')) return 'gif';
    const buf = file.buffer;
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
    if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    return null;
  }

  async uploadLogo(file?: {
    buffer?: Buffer;
    mimetype?: string;
    originalname?: string;
    size?: number;
  }): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    if (!file?.buffer?.length) return { ok: false, error: 'Choose an image to upload.' };
    if ((file.size ?? file.buffer.length) > LOGO_MAX_BYTES) {
      return { ok: false, error: 'Image must be 2 MB or smaller.' };
    }
    const ext = this.logoExt(file);
    if (!ext) return { ok: false, error: 'Use a JPG, PNG, WEBP, or GIF image.' };
    const objectPath = `${LOGO_PREFIX}${randomUUID()}.${ext}`;
    const contentType =
      ext === 'jpg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/webp';
    const uploaded = await r2PutObject({ key: objectPath, body: file.buffer, contentType });
    if (!uploaded.ok) return uploaded;
    const publicBase = r2PublicBaseUrl();
    const stored = publicBase ? `${publicBase}/${objectPath}` : objectPath;
    const path = this.normalizeImagePath(stored);
    if (!path) return { ok: false, error: `image path rejected: ${stored.slice(0, 200)}` };
    return { ok: true, path };
  }

  async getLogo(file: string): Promise<{ ok: true; body: Buffer; contentType: string } | { ok: false }> {
    const name = String(file ?? '').trim();
    if (!LOGO_FILE_RE.test(name)) return { ok: false };
    return r2GetObject(`${LOGO_PREFIX}${name}`);
  }

  private async loadSortOrderTitleMap(): Promise<Map<number, string>> {
    const { data, error } = await this.supabase
      .from(TABLE_PRODUCTS)
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
      policy: String(dto.policy ?? '').trim(),
      required_documents: normalizePartnerDocuments(dto.requiredDocuments),
      utm_link: this.normalizeUtmLink(dto.utmLink),
      image_path: this.normalizeImagePath(dto.imagePath),
    };

    const { data, error } = await this.table.insert(payload).select().single();

    if (error) {
      console.error('PartnerService.create', error.message, error.code);
      return null;
    }

    return this.enrichRow(data as Record<string, unknown>);
  }

  async updateById(id: string, dto: AdminUpdatePartnerDto): Promise<Record<string, unknown> | null> {
    const payload: Record<string, unknown> = {};

    if (dto.name != null) payload.name = dto.name.trim();
    if (dto.serviceId != null) payload.service_id = this.normalizeServiceId(dto.serviceId);
    if (dto.policy != null) payload.policy = dto.policy.trim();
    if (dto.requiredDocuments != null) payload.required_documents = normalizePartnerDocuments(dto.requiredDocuments);
    if (dto.utmLink != null) payload.utm_link = this.normalizeUtmLink(dto.utmLink);
    if (dto.imagePath != null) payload.image_path = this.normalizeImagePath(dto.imagePath);

    if (Object.keys(payload).length === 0) return null;

    const { data, error } = await this.table.update(payload).eq('id', id).select().single();

    if (error) {
      console.error('PartnerService.updateById', error.message, error.code);
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
