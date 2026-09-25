import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
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
}
