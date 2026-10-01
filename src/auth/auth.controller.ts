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
import { requestClientIp } from '../common/client-ip';
import { allowRateLimitedAction } from '../security/rate-limit';
import { AdminLoginDto } from './auth.dto';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: AdminLoginDto, @Req() req: Request) {
    const emailKey = dto.email.trim().toLowerCase();
    const ip = requestClientIp(req) || 'unknown';
    if (
      !allowRateLimitedAction(`admin-login:${emailKey}`, 8, 60_000) ||
      !allowRateLimitedAction(`admin-login-ip:${ip}`, 20, 60_000)
    ) {
      throw new BadRequestException('Too many login attempts. Try again in a minute.');
    }
    const user = await this.authService.verifyAdminLogin(dto.email, dto.password);
    return { ok: true, user };
  }
}
