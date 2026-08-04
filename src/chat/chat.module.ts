import { Module } from '@nestjs/common';
import { OtpModule } from '../otp/otp.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

@Module({
  imports: [OtpModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}

export { ChatService } from './chat.service';
export { ChatController } from './chat.controller';
export {
  CreateChatDto,
  UpdateChatDto,
} from './chat.dto';
