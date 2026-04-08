import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpsertUserDto } from './dto/upsert-user.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateMpinDto } from './dto/update-mpin.dto';
import { UpdateLoginStatusDto } from './dto/update-login-status.dto';
import { MSG_USER_CREATE_FAILED } from '../common/constants';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('mobile/:mobile')
  @HttpCode(HttpStatus.OK)
  async getByMobile(@Param('mobile') mobile: string) {
    const user = await this.usersService.getByMobile(mobile);
    if (!user) return { success: false, data: null };
    return { success: true, data: user };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateUserDto) {
    const user = await this.usersService.create(dto);
    if (!user) return { success: false, message: MSG_USER_CREATE_FAILED };
    return { success: true, data: user };
  }

  @Patch('mobile/:mobile/mpin')
  @HttpCode(HttpStatus.OK)
  async updateMpin(
    @Param('mobile') mobile: string,
    @Body() dto: UpdateMpinDto,
  ) {
    const ok = await this.usersService.updateMpin(mobile, dto);
    return { success: ok };
  }

  @Patch('mobile/:mobile/login-status')
  @HttpCode(HttpStatus.OK)
  async updateLoginStatus(
    @Param('mobile') mobile: string,
    @Body() dto: UpdateLoginStatusDto,
  ) {
    const ok = await this.usersService.updateLoginStatus(mobile, dto);
    return { success: ok };
  }

  @Patch('mobile/:mobile/profile')
  @HttpCode(HttpStatus.OK)
  async updateProfile(
    @Param('mobile') mobile: string,
    @Body() dto: UpdateProfileDto,
  ) {
    const ok = await this.usersService.updateProfile(mobile, dto);
    return { success: ok };
  }

  @Put('upsert')
  @HttpCode(HttpStatus.OK)
  async upsert(@Body() dto: UpsertUserDto) {
    const ok = await this.usersService.upsert(dto);
    return { success: ok };
  }
}
