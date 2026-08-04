import {
  IsOptional,
  IsString,
  Length,
  Matches,
  MinLength,
  Min,
} from 'class-validator';

export class CheckMobileDto {
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;
}

export class CustomerLoginDto {
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;

  @IsString()
  @MinLength(20, { message: 'idToken is required' })
  idToken: string;
}

export class ApplicationsDto {
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;
}

export class UpdateProfileDto {
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;

  @IsString()
  @MinLength(2, { message: 'Name must be at least 2 characters' })
  fullName: string;

  @IsOptional()
  @IsString()
  email?: string;
}

export type CustomerProfile = {
  name: string;
  mobile: string;
  email: string | null;
  pan: string | null;
  totalApplications: number;
  memberSince: string | null;
};

export type CustomerApplication = {
  id: string;
  applicationNumber: string;
  full_name: string;
  mobile_number: string;
  category: string;
  status: string;
  required_amount: number | null;
  ins_type: string | null;
  employment_type: string | null;
  net_monthly_income: number | null;
  created_at: string | null;
  updated_at: string | null;
  otp_verified: boolean;
};

export function asString(value: unknown): string {
  if (value == null) return '';
  return String(value).trim();
}

export function asAmount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === 'true';
}

export function applicationNumberFromId(id: string): string {
  const clean = id.replace(/[^a-zA-Z0-9]/g, '');
  const short = clean.slice(-8).toUpperCase() || clean.toUpperCase() || '--------';
  return `AZ-${short}`;
}

export function sanitizeApplication(row: Record<string, unknown>): CustomerApplication | null {
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
    ins_type: asString(row.ins_type) || null,
    employment_type: asString(row.employment_type) || null,
    net_monthly_income: asAmount(row.net_monthly_income),
    created_at: asString(row.created_at) || null,
    updated_at: asString(row.updated_at) || null,
    otp_verified: asBool(row.otp_verified),
  };
}
