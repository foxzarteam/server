import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { IsIn, IsObject, IsOptional, IsString, Length, Matches, MinLength } from 'class-validator';
import { assertMobileAccess, extractIdToken } from '../common/phone-access';
import { TABLE_CHAT } from '../common/constants';
import { SUPABASE_CLIENT } from '../config/supabase';
import { OtpModule, OtpService } from '../otp/otp.module';

const CHAT_STATUSES = [
  'started',
  'otp_sent',
  'otp_verified',
  'lead_submitted',
  'abandoned',
] as const;

type ChatAnswerItem = { id: string; label: string };
type ChatAnswers = {
  employment: ChatAnswerItem;
  salary: ChatAnswerItem;
  existing_emi: ChatAnswerItem;
  loan_amount: ChatAnswerItem;
};

class CreateChatDto {
  @IsString()
  @Length(10, 10, { message: 'Enter a valid 10-digit mobile number.' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Enter a valid 10-digit mobile number.' })
  mobileNumber: string;

  @IsObject()
  answers: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @IsIn([...CHAT_STATUSES])
  status?: string;
}

class UpdateChatDto {
  @IsOptional()
  @IsString()
  @IsIn([...CHAT_STATUSES])
  status?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  leadId?: string;

  @IsOptional()
  @IsString()
  @MinLength(20)
  idToken?: string;
}

function isAnswerItem(v: unknown): v is ChatAnswerItem {
  return (
    v != null &&
    typeof v === 'object' &&
    typeof (v as { id?: unknown }).id === 'string' &&
    typeof (v as { label?: unknown }).label === 'string'
  );
}

function parseAnswers(raw: unknown): ChatAnswers | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (
    !isAnswerItem(o.employment) ||
    !isAnswerItem(o.salary) ||
    !isAnswerItem(o.existing_emi) ||
    !isAnswerItem(o.loan_amount)
  ) {
    return null;
  }
  return {
    employment: { id: o.employment.id, label: o.employment.label },
    salary: { id: o.salary.id, label: o.salary.label },
    existing_emi: { id: o.existing_emi.id, label: o.existing_emi.label },
    loan_amount: { id: o.loan_amount.id, label: o.loan_amount.label },
  };
}

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

@Controller('chat')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly otpService: OtpService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateChatDto) {
    const answers = parseAnswers(dto.answers);
    if (!answers) {
      throw new BadRequestException('Chat answers are incomplete.');
    }
    const row = await this.chatService.create(dto);
    if (!row) {
      throw new BadRequestException('Could not save chat.');
    }
    return { success: true, id: row.id, status: row.status };
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateChatDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Headers('x-admin-internal-key') adminKey: string | undefined,
  ) {
    if (!id?.trim()) {
      throw new BadRequestException('Missing chat id.');
    }
    const mobile = await this.chatService.getMobileById(id);
    if (!mobile) {
      throw new NotFoundException('Chat not found or nothing to update.');
    }
    await assertMobileAccess(this.otpService, mobile, {
      adminKey,
      idToken: extractIdToken(headers, dto.idToken),
    });

    const row = await this.chatService.updateById(id, dto);
    if (!row) {
      throw new NotFoundException('Chat not found or nothing to update.');
    }
    return { success: true, id: row.id, status: row.status };
  }
}

@Module({
  imports: [OtpModule],
  controllers: [ChatController],
  providers: [ChatService],
})
export class ChatModule {}
