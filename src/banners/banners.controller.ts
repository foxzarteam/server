import { Controller, Get, HttpCode, HttpStatus, Param, UseGuards } from '@nestjs/common';
import { AdminCrmGuard } from '../common/admin-crm.guard';

import { BannersService } from './banners.service';

@Controller('banners')
export class BannersController {
  constructor(private readonly bannersService: BannersService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async getAllActive() {
    const banners = await this.bannersService.getAllActive();
    return { success: true, data: banners };
  }

  @Get('category/:category')
  @HttpCode(HttpStatus.OK)
  async getByCategory(@Param('category') category: string) {
    const decodedCategory = decodeURIComponent(category);
    const banners = await this.bannersService.getByCategory(decodedCategory);
    return { success: true, data: banners };
  }

  @Get('all')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async getAll() {
    const banners = await this.bannersService.getAll();
    return { success: true, data: banners };
  }
}
