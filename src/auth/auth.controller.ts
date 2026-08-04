import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { IsEmail, IsString, MinLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { SUPABASE_CLIENT } from '../config/supabase';
import { TABLE_AUTH } from '../common/constants';

import {
  AdminLoginDto,
} from './auth.dto';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: AdminLoginDto) {
    const user = await this.authService.verifyAdminLogin(dto.email, dto.password);
    return { ok: true, user };
  }
}
