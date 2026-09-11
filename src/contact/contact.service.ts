import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { TABLE_CONTACT } from '../common/constants';
import { SUPABASE_CLIENT } from '../config/supabase';
import {
  CreateContactDto,
  TaxCalculatorLeadDto,
  UpdateContactDto,
} from './contact.dto';

/** Hardcoded so CRM can filter tax-calculator page leads. */
export const TAX_CALCULATOR_LEAD_MESSAGE =
  'Lead coming from tax saving calculator';

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

  /**
   * Tax calculator lead: insert once per phone.
   * Duplicate phone → treated as ok (no second row).
   */
  async createTaxCalculatorLead(
    dto: TaxCalculatorLeadDto,
  ): Promise<{ id: string | null; created: boolean }> {
    const name = dto.name.trim().slice(0, 80);
    const phone = dto.phone.replace(/\D/g, '').slice(0, 10);

    if (!/^[6-9]\d{9}$/.test(phone) || name.length < 2) {
      return { id: null, created: false };
    }

    const { data: existing, error: findError } = await this.table
      .select('id')
      .eq('phone', phone)
      .limit(1)
      .maybeSingle();

    if (findError) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('ContactService.createTaxCalculatorLead.find', findError);
      }
      // Fail closed — do not insert when lookup is unreliable
      return { id: null, created: false };
    }

    if (existing?.id) {
      return { id: String(existing.id), created: false };
    }

    const { data, error } = await this.table
      .insert({
        name,
        email: '',
        phone,
        message: TAX_CALCULATOR_LEAD_MESSAGE,
        status: 'new',
        updated_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error || !data) {
      // Unique race / duplicate — treat as already saved
      if (error?.code === '23505') {
        return { id: null, created: false };
      }
      if (process.env.NODE_ENV !== 'production') {
        console.error('ContactService.createTaxCalculatorLead.insert', error);
      }
      return { id: null, created: false };
    }

    return { id: String((data as { id: string }).id), created: true };
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
