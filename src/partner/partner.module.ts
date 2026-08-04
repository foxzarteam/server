import { Module } from '@nestjs/common';
import { PartnerController } from './partner.controller';
import { PartnerService } from './partner.service';

@Module({
  controllers: [PartnerController],
  providers: [PartnerService],
  exports: [PartnerService],
})
export class PartnerModule {}

export { PartnerService } from './partner.service';
export { PartnerController } from './partner.controller';
export {
  AdminCreatePartnerDto,
  AdminUpdatePartnerDto,
} from './partner.dto';
