import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ServicesService } from './services.service';

@Controller('services')
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async getActive() {
    const services = await this.servicesService.getActivePublic();
    return { success: true, data: services };
  }
}
