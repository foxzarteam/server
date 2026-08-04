import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { SendOtpDto, VerifyFirebaseOtpDto } from './otp.dto';
import { OtpService } from './otp.service';

@Controller('otp')
export class OtpController {
  constructor(
    private readonly otpService: OtpService,
    private readonly config: ConfigService,
  ) {}

  /** Dev / legacy: create OTP session row before or after client SMS. */
  @Post('send')
  @HttpCode(HttpStatus.OK)
  async send(@Body() dto: SendOtpDto) {
    return this.otpService.send(dto);
  }

  /** Prefer this: rate-limit check + insert send row before Firebase SMS. */
  @Post('request-send')
  @HttpCode(HttpStatus.OK)
  async requestSend(@Body() dto: SendOtpDto) {
    return this.otpService.requestSend(dto);
  }

  @Post('verify-firebase')
  @HttpCode(HttpStatus.OK)
  async verifyFirebase(@Body() dto: VerifyFirebaseOtpDto) {
    return this.otpService.verifyFirebaseToken(dto);
  }

  /** Optional HTML debug page in non-production. */
  @Get('status-page')
  async statusPage(@Res() res: Response) {
    if (this.config.get<string>('NODE_ENV') === 'production') {
      return res.status(404).send('Not found');
    }
    return res
      .type('html')
      .send(
        '<!doctype html><html><body><h1>OTP API</h1><p>OK</p></body></html>',
      );
  }
}
