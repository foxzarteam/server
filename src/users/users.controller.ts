import {
  Body,
  BadRequestException,
  ConflictException,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminCrmGuard, AdminOnlyGuard } from '../common/admin-crm.guard';
import { extractClientIp } from '../common/client-ip';
import { sanitizeUserPublic } from '../common/mpin';
import { assertMobileAccess, assertStrictMobileAccess, extractIdToken } from '../common/phone-access';
import { MSG_USER_CREATE_FAILED } from '../common/constants';
import { allowRateLimitedAction } from '../security/rate-limit';
import {
  clearMpinFailures,
  isMpinLocked,
  recordMpinFailure,
} from '../security/mpin-lockout';
import { OtpService } from '../otp/otp.service';
import {
  AgentLoginDto,
  AdminCreateUserDto,
  AdminUpdateUserDto,
  CreateUserDto,
  UpdateLoginStatusDto,
  UpdateMpinDto,
  UpdateProfileDto,
  UpsertUserDto,
  VerifyMpinDto,
} from './users.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly otpService: OtpService,
  ) {}

  private idTokenFrom(
    headers: Record<string, string | string[] | undefined>,
    bodyToken?: unknown,
  ): string | undefined {
    return extractIdToken(headers, bodyToken);
  }

  private clientIp(req: Request): string | null {
    return extractClientIp(
      req.headers as Record<string, string | string[] | undefined>,
      req.ip ?? req.socket?.remoteAddress,
    );
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
    return { success: true, data: user };
  }

  @Post('agent/register')
  @HttpCode(HttpStatus.CREATED)
  async agentRegister(
    @Body() dto: AdminCreateUserDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    if (!allowRateLimitedAction(`agent-register:${dto.mobileNumber}`, 3, 60_000)) {
      throw new BadRequestException('Too many attempts. Try again in a minute.');
    }
    // Optional Firebase: when idToken present, verify it; never auto-grant CRM session here.
    const idToken = this.idTokenFrom(headers, dto.idToken);
    if (idToken) {
      await assertStrictMobileAccess(this.otpService, dto.mobileNumber, { idToken });
    }
    const result = await this.usersService.createForAdmin(dto);
    if (!result.ok) {
      if (result.duplicate) {
        throw new BadRequestException('Unable to complete registration');
      }
      throw new BadRequestException(result.message);
    }
    return { success: true, data: result.user };
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

  @Get('mobile/:mobile')
  @HttpCode(HttpStatus.OK)
  async getByMobile(
    @Param('mobile') mobile: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Headers('x-admin-internal-key') adminKey: string | undefined,
  ) {
    await assertStrictMobileAccess(this.otpService, mobile, {
      adminKey,
      idToken: this.idTokenFrom(headers),
    });
    const user = await this.usersService.getByMobile(mobile);
    if (!user) return { success: false, data: null };
    return { success: true, data: sanitizeUserPublic(user) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateUserDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Headers('x-admin-internal-key') adminKey: string | undefined,
  ) {
    await assertMobileAccess(this.otpService, dto.mobileNumber, {
      adminKey,
      idToken: this.idTokenFrom(headers, dto.idToken),
    });
    const user = await this.usersService.create(dto);
    if (!user) return { success: false, message: MSG_USER_CREATE_FAILED };
    return { success: true, data: sanitizeUserPublic(user) };
  }

  @Post('mobile/:mobile/verify-mpin')
  @HttpCode(HttpStatus.OK)
  async verifyMpinRoute(
    @Param('mobile') mobile: string,
    @Body() dto: VerifyMpinDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Headers('x-admin-internal-key') adminKey: string | undefined,
  ) {
    if (!allowRateLimitedAction(`verify-mpin:${mobile.trim()}`, 5, 60_000)) {
      throw new BadRequestException('Too many attempts. Try again in a minute.');
    }
    await assertStrictMobileAccess(this.otpService, mobile, {
      adminKey,
      idToken: this.idTokenFrom(headers, dto.idToken),
    });
    const lock = isMpinLocked(mobile);
    if (lock.locked) {
      return { success: false, locked: true, retryAfterSec: lock.retryAfterSec };
    }
    const ok = await this.usersService.verifyMpin(mobile, dto.mpin);
    if (!ok) {
      const after = recordMpinFailure(mobile);
      return {
        success: false,
        locked: after.locked,
        retryAfterSec: after.retryAfterSec || undefined,
      };
    }
    clearMpinFailures(mobile);
    return { success: true };
  }

  @Patch('mobile/:mobile/mpin')
  @HttpCode(HttpStatus.OK)
  async updateMpin(
    @Param('mobile') mobile: string,
    @Body() dto: UpdateMpinDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Headers('x-admin-internal-key') adminKey: string | undefined,
  ) {
    await assertStrictMobileAccess(this.otpService, mobile, {
      adminKey,
      idToken: this.idTokenFrom(headers, dto.idToken),
    });
    const ok = await this.usersService.updateMpin(mobile, dto.mpin);
    return { success: ok };
  }

  @Patch('mobile/:mobile/login-status')
  @HttpCode(HttpStatus.OK)
  async updateLoginStatus(
    @Param('mobile') mobile: string,
    @Body() dto: UpdateLoginStatusDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Headers('x-admin-internal-key') adminKey: string | undefined,
  ) {
    await assertStrictMobileAccess(this.otpService, mobile, {
      adminKey,
      idToken: this.idTokenFrom(headers, dto.idToken),
    });
    const ok = await this.usersService.updateLoginStatus(mobile, dto);
    return { success: ok };
  }

  @Patch('mobile/:mobile/profile')
  @HttpCode(HttpStatus.OK)
  async updateProfile(
    @Param('mobile') mobile: string,
    @Body() dto: UpdateProfileDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Headers('x-admin-internal-key') adminKey: string | undefined,
  ) {
    await assertStrictMobileAccess(this.otpService, mobile, {
      adminKey,
      idToken: this.idTokenFrom(headers, dto.idToken),
    });
    const ok = await this.usersService.updateProfile(mobile, dto);
    return { success: ok };
  }

  @Put('upsert')
  @HttpCode(HttpStatus.OK)
  async upsert(
    @Body() dto: UpsertUserDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Headers('x-admin-internal-key') adminKey: string | undefined,
  ) {
    const access = dto.mpin
      ? assertStrictMobileAccess
      : assertMobileAccess;
    await access(this.otpService, dto.mobileNumber, {
      adminKey,
      idToken: this.idTokenFrom(headers, dto.idToken),
    });
    const ok = await this.usersService.upsert(dto);
    return { success: ok };
  }
}
