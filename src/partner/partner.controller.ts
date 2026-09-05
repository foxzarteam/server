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
  UseGuards,
} from '@nestjs/common';
import { AdminCrmGuard, AdminOnlyGuard } from '../common/admin-crm.guard';
import {
  AdminCreatePartnerDto,
  AdminUpdatePartnerDto,
} from './partner.dto';
import { PartnerService } from './partner.service';

@Controller('partners')
export class PartnerController {
  constructor(private readonly partnerService: PartnerService) {}

  @Get('admin/all')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async getAllForAdmin() {
    const data = await this.partnerService.getAll();
    return { success: true, data };
  }

  @Post('admin')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.CREATED)
  async createForAdmin(@Body() dto: AdminCreatePartnerDto) {
    const row = await this.partnerService.create(dto);
    if (!row) {
      throw new NotFoundException('Failed to create partner');
    }
    return { success: true, data: row };
  }

  @Patch('admin/:id')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async updateForAdmin(@Param('id') id: string, @Body() dto: AdminUpdatePartnerDto) {
    const row = await this.partnerService.updateById(id, dto);
    if (!row) {
      throw new NotFoundException('Partner not found or update failed');
    }
    return { success: true, data: row };
  }

  @Delete('admin/:id')
  @UseGuards(AdminCrmGuard, AdminOnlyGuard)
  @HttpCode(HttpStatus.OK)
  async deleteForAdmin(@Param('id') id: string) {
    const ok = await this.partnerService.deleteById(id);
    if (!ok) {
      throw new NotFoundException('Partner not found or delete failed');
    }
    return { success: true };
  }
}
