import { Module } from '@nestjs/common';
import { AdminCrmGuard, AdminOnlyGuard } from '../common/admin-crm.guard';
import { PartnerController } from './partner.controller';
import { PartnerService } from './partner.service';

@Module({
  controllers: [PartnerController],
  providers: [PartnerService, AdminCrmGuard, AdminOnlyGuard],
  exports: [PartnerService],
})
export class PartnerModule {}

export { PartnerService } from './partner.service';
export { PartnerController } from './partner.controller';
export {
  AdminCreatePartnerDto,
  AdminUpdatePartnerDto,
} from './partner.dto';
