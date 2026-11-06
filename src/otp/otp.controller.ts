import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { SendOtpDto, VerifyFirebaseOtpDto } from './otp.dto';

@Controller('otp')
export class OtpController {
  /** Firebase OTP is off — public apply and customer login no longer send SMS. */
  @Post('request-send')
  @HttpCode(HttpStatus.OK)
  requestSend(@Body() _dto: SendOtpDto) {
    return {
      success: false,
      message: 'OTP is disabled. Submit the form without OTP.',
      remainingSends: 0,
    };
  }

  @Post('verify-firebase')
  @HttpCode(HttpStatus.OK)
  verifyFirebase(@Body() _dto: VerifyFirebaseOtpDto) {
    return {
      success: false,
      message: 'OTP is disabled. Submit the form without OTP.',
    };
  }
}
