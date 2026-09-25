import {
  Body,
  BadRequestException,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminCrmGuard, AdminOnlyGuard } from '../common/admin-crm.guard';
import { extractClientIp } from '../common/client-ip';
import { issuePartnerToken } from '../common/partner-session';
import { allowRateLimitedAction } from '../security/rate-limit';
import {
  clearMpinFailures,
  isMpinLocked,
  recordMpinFailure,
} from '../security/mpin-lockout';
import {
  AgentLoginDto,
  AdminCreateUserDto,
  AdminUpdateUserDto,
} from './users.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  private clientIp(req: Request): string | null {
    return extractClientIp(
      req.headers as Record<string, string | string[] | undefined>,
      req.ip ?? req.socket?.remoteAddress,
    );
  }

  private withPartnerToken(user: Record<string, unknown>) {
    const id = String(user.id ?? '').trim();
    const mobile = String(user.mobile_number ?? '').trim();
    return {
      success: true as const,
      data: user,
      token: issuePartnerToken({ id, mobile }),
    };
  }

  @Post('agent/login')
  @HttpCode(HttpStatus.OK)
  async agentLogin(@Body() dto: AgentLoginDto, @Req() req: Request) {
    const mobile = dto.mobileNumber.trim();
    if (!allowRateLimitedAction(`agent-login:${mobile}`, 5, 60_000)) {
      throw new BadRequestException('Too many attempts. Try again in a minute.');
    }
    const ip = this.clientIp(req);
    if (ip && !allowRateLimitedAction(`agent-login-ip:${ip}`, 5, 60_000)) {
      throw new BadRequestException('Too many attempts. Try again in a minute.');
    }

    const lock = isMpinLocked(mobile);
    if (lock.locked) {
      throw new UnauthorizedException(
        `Too many failed attempts. Try again in ${lock.retryAfterSec} seconds.`,
      );
    }

    const user = await this.usersService.loginAgent(mobile, dto.mpin);
    if (!user) {
      const after = recordMpinFailure(mobile);
      if (after.locked) {
        throw new UnauthorizedException(
          `Too many failed attempts. Try again in ${after.retryAfterSec} seconds.`,
        );
      }
      throw new UnauthorizedException('Invalid phone or PIN');
    }
    clearMpinFailures(mobile);
    return this.withPartnerToken(user);
  }

  @Post('agent/register')
  @HttpCode(HttpStatus.CREATED)
  async agentRegister(@Body() dto: AdminCreateUserDto) {
    if (!allowRateLimitedAction(`agent-register:${dto.mobileNumber}`, 3, 60_000)) {
      throw new BadRequestException('Too many attempts. Try again in a minute.');
    }
    const result = await this.usersService.createForAdmin(dto);
    if (!result.ok) {
      if (result.duplicate) {
        throw new ConflictException(result.message || 'This phone number is already registered. Please log in.');
      }
      throw new BadRequestException(result.message);
    }
    return this.withPartnerToken(result.user);
  }

  @Get('admin/all')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async getAllForAdmin() {
    const users = await this.usersService.getAll();
    return { success: true, data: users };
  }

  @Post('admin')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.CREATED)
  async createForAdmin(@Body() dto: AdminCreateUserDto) {
    const result = await this.usersService.createForAdmin(dto);
    if (!result.ok) {
      if (result.duplicate) {
        throw new ConflictException(result.message);
      }
      throw new BadRequestException(result.message);
    }
    return { success: true, data: result.user };
  }

  @Patch('admin/:id')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async updateForAdmin(@Param('id') id: string, @Body() dto: AdminUpdateUserDto) {
    const user = await this.usersService.updateById(id, dto);
    if (!user) {
      throw new NotFoundException('User not found or update failed');
    }
    return { success: true, data: user };
  }

  @Delete('admin/:id')
  @UseGuards(AdminCrmGuard, AdminOnlyGuard)
  @HttpCode(HttpStatus.OK)
  async deleteForAdmin(@Param('id') id: string) {
    const ok = await this.usersService.deleteById(id);
    if (!ok) {
      throw new NotFoundException('User not found or delete failed');
    }
    return { success: true };
  }
}
