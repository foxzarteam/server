import { Controller, Get, Module } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  ping() {
    return { ok: true, service: 'bankers-api' };
  }
}

@Module({
  controllers: [HealthController],
})
export class HealthModule {}
