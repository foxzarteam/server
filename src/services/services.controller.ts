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
  UseGuards,
} from '@nestjs/common';
import { AdminCrmGuard, AdminOnlyGuard } from '../common/admin-crm.guard';
import { AdminUpdateServiceDto } from './services.dto';
import { ServicesService } from './services.service';

@Controller('services')
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Get('admin/all')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async getAllForAdmin() {
    const services = await this.servicesService.getAll();
    return { success: true, data: services };
  }

  @Patch('admin/:id')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async updateForAdmin(@Param('id') id: string, @Body() dto: AdminUpdateServiceDto) {
    const service = await this.servicesService.updateById(id, dto);
    if (!service) {
      throw new NotFoundException('Service not found or update failed');
    }
    return { success: true, data: service };
  }

  @Delete('admin/:id')
  @UseGuards(AdminCrmGuard, AdminOnlyGuard)
  @HttpCode(HttpStatus.OK)
  async deleteForAdmin(@Param('id') id: string) {
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
