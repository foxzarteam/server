import { Module } from '@nestjs/common';
import { AdminCrmGuard, AdminOnlyGuard } from '../common/admin-crm.guard';
import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';

@Module({
  controllers: [ContactController],
  providers: [ContactService, AdminCrmGuard, AdminOnlyGuard],
  exports: [ContactService],
})
export class ContactModule {}

export { ContactService } from './contact.service';
export { ContactController } from './contact.controller';
export {
  CreateContactDto,
  UpdateContactDto,
} from './contact.dto';
