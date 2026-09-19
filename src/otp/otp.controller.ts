import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  BadRequestException,
} from '@nestjs/common';
import type { Request } from 'express';
import { extractClientIp } from '../common/client-ip';
import { allowRateLimitedAction } from '../security/rate-limit';
import { SendOtpDto, VerifyFirebaseOtpDto } from './otp.dto';
import { OtpService } from './otp.service';

@Controller('otp')
export class OtpController {
  constructor(private readonly otpService: OtpService) {}

  /** Dev / legacy: create OTP session row before or after client SMS. */
  @Post('send')
  @HttpCode(HttpStatus.OK)
  async send(@Body() dto: SendOtpDto) {
    return this.otpService.send(dto);
  }

  /** Prefer this: rate-limit check + insert send row before Firebase SMS. */
  @Post('request-send')
  @HttpCode(HttpStatus.OK)
  async requestSend(@Body() dto: SendOtpDto, @Req() req: Request) {
    const ip =
      extractClientIp(
        req.headers as Record<string, string | string[] | undefined>,
        req.ip ?? req.socket?.remoteAddress,
      ) ?? 'unknown';
    if (!allowRateLimitedAction(`otp-request-ip:${ip}`, 12, 60_000)) {
      throw new BadRequestException('Too many OTP requests. Please try again in a minute.');
    }
    return this.otpService.requestSend(dto);
  }

  @Post('verify-firebase')
  @HttpCode(HttpStatus.OK)
  async verifyFirebase(@Body() dto: VerifyFirebaseOtpDto) {
    return this.otpService.verifyFirebaseToken(dto);
  }
}
