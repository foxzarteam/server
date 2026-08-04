import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { TABLE_CHAT } from '../common/constants';
import { SUPABASE_CLIENT } from '../config/supabase';
import {
  CHAT_STATUSES,
  CreateChatDto,
  parseAnswers,
  UpdateChatDto,
} from './chat.dto';

@Injectable()
export class ChatService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  private get table() {
    return this.supabase.from(TABLE_CHAT);
  }

  async create(dto: CreateChatDto): Promise<{ id: string; status: string } | null> {
    const answers = parseAnswers(dto.answers);
    if (!answers) return null;

    const status =
      dto.status && CHAT_STATUSES.includes(dto.status as (typeof CHAT_STATUSES)[number])
        ? dto.status
        : 'otp_sent';

    const { data, error } = await this.table
      .insert({
        mobile_number: dto.mobileNumber.trim(),
        answers,
        status,
        updated_at: new Date().toISOString(),
      })
      .select('id, status')
      .single();

    if (error || !data) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('ChatService.create', error);
      }
      return null;
    }
    const row = data as { id: string; status: string };
    return { id: String(row.id), status: String(row.status) };
  }

  async getMobileById(id: string): Promise<string | null> {
    const { data, error } = await this.table
      .select('mobile_number')
      .eq('id', id.trim())
      .maybeSingle();
    if (error || !data) {
      if (process.env.NODE_ENV !== 'production' && error) {
        console.error('ChatService.getMobileById', error);
      }
      return null;
    }
    const mobile = String((data as { mobile_number?: string }).mobile_number ?? '').trim();
    return mobile || null;
  }

  async updateById(
    id: string,
    dto: UpdateChatDto,
  ): Promise<{ id: string; status: string } | null> {
    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (dto.status != null) payload.status = dto.status;
    if (dto.leadId?.trim()) payload.lead_id = dto.leadId.trim();
    if (Object.keys(payload).length <= 1) return null;

    const { data, error } = await this.table
      .update(payload)
      .eq('id', id)
      .select('id, status')
      .single();

    if (error || !data) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('ChatService.updateById', error);
      }
      return null;
    }
    const row = data as { id: string; status: string };
    return { id: String(row.id), status: String(row.status) };
  }
}
