import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { AdminCrmGuard, AdminOnlyGuard } from '../common/admin-crm.guard';
import { allowRateLimitedAction } from '../security/rate-limit';
import { CreateContactDto, UpdateContactDto } from './contact.dto';
import { ContactService } from './contact.service';

@Controller('contact')
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  /** Public contact form submit. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateContactDto) {
    const emailKey = (dto.email ?? 'anon').trim().toLowerCase().slice(0, 80);
    if (!allowRateLimitedAction(`contact:${emailKey}`, 5, 60_000)) {
      throw new BadRequestException('Too many messages. Please try again in a minute.');
    }
    const row = await this.contactService.create(dto);
    if (!row) {
      throw new BadRequestException('Could not save your message.');
    }
    return { success: true, id: row.id };
  }

  @Get('admin/all')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async getAllForAdmin() {
    const data = await this.contactService.getAll();
    return { success: true, data };
  }

  @Patch('admin/:id')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async updateForAdmin(@Param('id') id: string, @Body() dto: UpdateContactDto) {
    const data = await this.contactService.updateById(id, dto);
    if (!data) {
      throw new NotFoundException('Contact not found or update failed');
    }
    return { success: true, data };
  }

  @Delete('admin/:id')
  @UseGuards(AdminCrmGuard, AdminOnlyGuard)
  @HttpCode(HttpStatus.OK)
  async deleteForAdmin(@Param('id') id: string) {
    const ok = await this.contactService.deleteById(id);
    if (!ok) {
      throw new NotFoundException('Contact not found or delete failed');
    }
    return { success: true };
  }
}
