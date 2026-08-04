import { Module } from '@nestjs/common';
import { ServicesController } from './services.controller';
import { ServicesService } from './services.service';

@Module({
  controllers: [ServicesController],
  providers: [ServicesService],
  exports: [ServicesService],
})
export class ServicesModule {}

export { ServicesService } from './services.service';
export { ServicesController } from './services.controller';
export {
  AdminUpdateServiceDto,
} from './services.dto';
