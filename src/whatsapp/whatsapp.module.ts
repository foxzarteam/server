import { Module } from '@nestjs/common';
import { AdminCrmGuard } from '../common/admin-crm.guard';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { WhatsappSettingsService } from './whatsapp-settings.service';

@Module({
  controllers: [WhatsappController],
  providers: [WhatsappService, WhatsappSettingsService, AdminCrmGuard],
  exports: [WhatsappService],
})
export class WhatsappModule {}
