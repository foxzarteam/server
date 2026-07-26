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
  BadRequestException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MinLength,
} from 'class-validator';
import { adminInternalKeyOk } from '../common/admin-internal';
import { TABLE_CONTACT } from '../common/constants';
import { SUPABASE_CLIENT } from '../config/supabase';

const CONTACT_STATUSES = ['new', 'read', 'replied', 'archived'] as const;

class CreateContactDto {
  @IsString()
  @MinLength(2, { message: 'Please enter your name.' })
  name: string;

  @IsEmail({}, { message: 'Please enter a valid email.' })
  email: string;

  @IsString()
  @Length(10, 10, { message: 'Please enter a valid 10-digit mobile number.' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Please enter a valid 10-digit mobile number.' })
  phone: string;

  @IsString()
  @MinLength(3, { message: 'Please enter a message.' })
  message: string;
}

class UpdateContactDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @Length(10, 10)
  @Matches(/^[6-9]\d{9}$/)
  phone?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  message?: string;

  @IsOptional()
  @IsString()
  @IsIn([...CONTACT_STATUSES])
  status?: string;
}

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

@Controller('contact')
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  /** Public contact form submit. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateContactDto) {
    const row = await this.contactService.create(dto);
    if (!row) {
      throw new BadRequestException('Could not save your message.');
    }
    return { success: true, id: row.id };
  }

  @Get('admin/all')
  @HttpCode(HttpStatus.OK)
  async getAllForAdmin(@Headers('x-admin-internal-key') adminKey: string | undefined) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const data = await this.contactService.getAll();
    return { success: true, data };
  }

  @Patch('admin/:id')
  @HttpCode(HttpStatus.OK)
  async updateForAdmin(
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdateContactDto,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const data = await this.contactService.updateById(id, dto);
    if (!data) {
      throw new NotFoundException('Contact not found or update failed');
    }
    return { success: true, data };
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
    const ok = await this.contactService.deleteById(id);
    if (!ok) {
      throw new NotFoundException('Contact not found or delete failed');
    }
    return { success: true };
  }
}

@Module({
  controllers: [ContactController],
  providers: [ContactService],
})
export class ContactModule {}
