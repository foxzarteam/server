import { Module } from '@nestjs/common';
import { OtpController } from './otp.controller';
import { OtpService } from './otp.service';

@Module({
  controllers: [OtpController],
  providers: [OtpService],
  exports: [OtpService],
})
export class OtpModule {}

export { OtpService } from './otp.service';
export { OtpController } from './otp.controller';
export {
  SendOtpDto,
  VerifyFirebaseOtpDto,
} from './otp.dto';
