import { Module } from '@nestjs/common';
import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';

@Module({
  controllers: [ContactController],
  providers: [ContactService],
  exports: [ContactService],
})
export class ContactModule {}

export { ContactService } from './contact.service';
export { ContactController } from './contact.controller';
export {
  CreateContactDto,
  UpdateContactDto,
} from './contact.dto';
