import {
  Body,
  Controller,
  Delete,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import type { Request } from 'express';
import { adminInternalKeyOk } from '../common/admin-internal';
import { extractClientIp } from '../common/client-ip';
import { allowRateLimitedAction } from '../security/rate-limit';

import {
  CheckMobileDto,
  CustomerLoginDto,
  ApplicationsDto,
  UpdateProfileDto,
} from './customer.dto';
import { CustomerService } from './customer.service';

@Controller('customer')
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  /** Public: does this mobile have any active loan application? */
  @Post('check-mobile')
  @HttpCode(HttpStatus.OK)
  async checkMobile(@Body() dto: CheckMobileDto, @Req() req: Request) {
    const mobile = dto.mobileNumber.trim();
    const ip =
      extractClientIp(
        req.headers as Record<string, string | string[] | undefined>,
        req.ip ?? req.socket?.remoteAddress,
      ) ?? 'unknown';
    if (!allowRateLimitedAction(`check-mobile:${mobile}:${ip}`, 5, 60_000)) {
      throw new BadRequestException('Too many attempts. Try again in a minute.');
    }
    const exists = await this.customerService.mobileHasApplication(mobile);
    return { success: true, exists };
  }

  /**
   * Public: verify Firebase OTP + return applications for customer track login.
   * az_web sets the session cookie from this response.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: CustomerLoginDto) {
    const result = await this.customerService.login(dto.mobileNumber, dto.idToken);
    if (!result.ok) {
      const msg = result.message || 'Login failed.';
      const notFound = msg.toLowerCase().includes('no application');
      return {
        success: false,
        message: msg,
        code: notFound ? 'NO_APPLICATION' : 'LOGIN_FAILED',
      };
    }
    return {
      success: true,
      customer: result.customer,
      applications: result.applications,
    };
  }

  /**
   * BFF-only: list applications by mobile after az_web session is established.
   * Requires `x-admin-internal-key` (same as other Nest internal admin routes).
   */
  @Post('applications')
  @HttpCode(HttpStatus.OK)
  async applications(
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Body() dto: ApplicationsDto,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const applications = await this.customerService.getApplications(dto.mobileNumber);
    return {
      success: true,
      customer: {
        mobile: dto.mobileNumber.trim(),
        name: applications[0]?.full_name || 'Customer',
      },
      applications,
    };
  }

  /** BFF-only: read customer profile derived from their applications. */
  @Post('profile')
  @HttpCode(HttpStatus.OK)
  async profile(
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Body() dto: ApplicationsDto,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const profile = await this.customerService.getProfile(dto.mobileNumber);
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    return { success: true, profile };
  }

  /** BFF-only: customer updates own name / email. */
  @Patch('profile')
  @HttpCode(HttpStatus.OK)
  async updateProfile(
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Body() dto: UpdateProfileDto,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const result = await this.customerService.updateProfile(dto.mobileNumber, {
      fullName: dto.fullName,
      email: dto.email,
    });
    if (!result.ok) {
      return { success: false, message: result.message || 'Update failed' };
    }
    return { success: true, profile: result.profile };
  }

  /** BFF-only: customer deletes own application (mobile must match). */
  @Delete('applications/:id')
  @HttpCode(HttpStatus.OK)
  async deleteApplication(
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Param('id') id: string,
    @Body() dto: ApplicationsDto,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const result = await this.customerService.deleteOwnApplication(id, dto.mobileNumber);
    if (!result.ok) {
      throw new NotFoundException(result.message || 'Application not found');
    }
    return { success: true };
  }
}
