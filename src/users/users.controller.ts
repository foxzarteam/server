import {
  Body,
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
  UnauthorizedException,
} from '@nestjs/common';
import { adminInternalKeyOk } from '../common/admin-internal';
import { sanitizeUserPublic } from '../common/mpin';
import { assertMobileAccess, extractIdToken } from '../common/phone-access';
import { MSG_USER_CREATE_FAILED } from '../common/constants';
import { OtpService } from '../otp/otp.service';
import {
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

  @Get('admin/all')
  @HttpCode(HttpStatus.OK)
  async getAllForAdmin(@Headers('x-admin-internal-key') adminKey: string | undefined) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const users = await this.usersService.getAll();
    return { success: true, data: users };
  }

  @Patch('admin/:id')
  @HttpCode(HttpStatus.OK)
  async updateForAdmin(
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Param('id') id: string,
    @Body() dto: AdminUpdateUserDto,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const user = await this.usersService.updateById(id, dto);
    if (!user) {
      throw new NotFoundException('User not found or update failed');
    }
    return { success: true, data: user };
  }

  @Delete('admin/:id')
  @HttpCode(HttpStatus.OK)
  async deleteForAdmin(
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Param('id') id: string,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
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
    await assertMobileAccess(this.otpService, mobile, {
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
    await assertMobileAccess(this.otpService, mobile, {
      adminKey,
      idToken: this.idTokenFrom(headers, dto.idToken),
    });
    const ok = await this.usersService.verifyMpin(mobile, dto.mpin);
    return { success: ok };
  }

  @Patch('mobile/:mobile/mpin')
  @HttpCode(HttpStatus.OK)
  async updateMpin(
    @Param('mobile') mobile: string,
    @Body() dto: UpdateMpinDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Headers('x-admin-internal-key') adminKey: string | undefined,
  ) {
    await assertMobileAccess(this.otpService, mobile, {
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
    await assertMobileAccess(this.otpService, mobile, {
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
    await assertMobileAccess(this.otpService, mobile, {
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
    await assertMobileAccess(this.otpService, dto.mobileNumber, {
      adminKey,
      idToken: this.idTokenFrom(headers, dto.idToken),
    });
    const ok = await this.usersService.upsert(dto);
    return { success: ok };
  }
}
