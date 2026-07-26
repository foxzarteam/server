import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Injectable,
  Module,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { IsString, Length, Matches, MinLength } from 'class-validator';
import { adminInternalKeyOk } from '../common/admin-internal';
import { LeadsModule, LeadsService } from '../leads/leads.module';
import { OtpModule, OtpService } from '../otp/otp.module';

class CheckMobileDto {
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;
}

class CustomerLoginDto {
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;

  @IsString()
  @MinLength(20, { message: 'idToken is required' })
  idToken: string;
}

class ApplicationsDto {
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;
}

export type CustomerApplication = {
  id: string;
  applicationNumber: string;
  full_name: string;
  mobile_number: string;
  category: string;
  status: string;
  required_amount: number | null;
  created_at: string | null;
  updated_at: string | null;
  otp_verified: boolean;
};

function asString(value: unknown): string {
  if (value == null) return '';
  return String(value).trim();
}

function asAmount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === 'true';
}

function applicationNumberFromId(id: string): string {
  const clean = id.replace(/[^a-zA-Z0-9]/g, '');
  const short = clean.slice(-8).toUpperCase() || clean.toUpperCase() || '--------';
  return `AZ-${short}`;
}

function sanitizeApplication(row: Record<string, unknown>): CustomerApplication | null {
  const id = asString(row.id);
  if (!id) return null;
  return {
    id,
    applicationNumber: applicationNumberFromId(id),
    full_name: asString(row.full_name) || 'Applicant',
    mobile_number: asString(row.mobile_number),
    category: asString(row.category) || 'personal_loan',
    status: asString(row.status).toLowerCase() || 'pending',
    required_amount: asAmount(row.required_amount),
    created_at: asString(row.created_at) || null,
    updated_at: asString(row.updated_at) || null,
    otp_verified: asBool(row.otp_verified),
  };
}

@Injectable()
export class CustomerService {
  constructor(
    private readonly leadsService: LeadsService,
    private readonly otpService: OtpService,
  ) {}

  async getApplications(mobileNumber: string): Promise<CustomerApplication[]> {
    const rows = await this.leadsService.listByMobile(mobileNumber.trim());
    return rows
      .filter((row) => !this.leadsService.isDraftLead(row))
      .map(sanitizeApplication)
      .filter((a): a is CustomerApplication => a != null);
  }

  async mobileHasApplication(mobileNumber: string): Promise<boolean> {
    const apps = await this.getApplications(mobileNumber);
    return apps.length > 0;
  }

  async login(
    mobileNumber: string,
    idToken: string,
  ): Promise<{
    ok: boolean;
    message?: string;
    customer?: { mobile: string; name: string };
    applications?: CustomerApplication[];
  }> {
    const mobile = mobileNumber.trim();
    const verified = await this.otpService.verifyFirebaseToken({
      mobileNumber: mobile,
      idToken,
    });
    if (!verified.success) {
      return {
        ok: false,
        message: verified.message || 'OTP verification expired. Please verify again.',
      };
    }

    const applications = await this.getApplications(mobile);
    if (applications.length === 0) {
      return {
        ok: false,
        message:
          'No application found for this number. Please fill the Personal Loan form first.',
      };
    }

    return {
      ok: true,
      customer: {
        mobile,
        name: applications[0]?.full_name || 'Customer',
      },
      applications,
    };
  }
}

@Controller('customer')
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  /** Public: does this mobile have any active loan application? */
  @Post('check-mobile')
  @HttpCode(HttpStatus.OK)
  async checkMobile(@Body() dto: CheckMobileDto) {
    const exists = await this.customerService.mobileHasApplication(dto.mobileNumber);
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
}

@Module({
  imports: [LeadsModule, OtpModule],
  controllers: [CustomerController],
  providers: [CustomerService],
})
export class CustomerModule {}
