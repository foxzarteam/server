import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  BadRequestException,
} from '@nestjs/common';
import { allowRateLimitedAction } from '../security/rate-limit';
import { AdminLoginDto } from './auth.dto';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: AdminLoginDto) {
    const emailKey = dto.email.trim().toLowerCase();
    if (!allowRateLimitedAction(`admin-login:${emailKey}`, 8, 60_000)) {
      throw new BadRequestException('Too many login attempts. Try again in a minute.');
    }
    const user = await this.authService.verifyAdminLogin(dto.email, dto.password);
    return { ok: true, user };
  }
}
