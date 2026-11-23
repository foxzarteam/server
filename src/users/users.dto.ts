import {
  Allow,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MinLength,
  ValidateIf,
} from 'class-validator';

export const PARTNER_KYC_STATUSES = ['pending', 'submitted', 'approved', 'rejected'] as const;
export type PartnerKycStatus = (typeof PARTNER_KYC_STATUSES)[number];

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  userName?: string;

  @IsOptional()
  @IsString()
  email?: string;
}

export class UpdateMpinDto {
  @IsString()
  @Length(4, 4, { message: 'mpin must be 4 digits' })
  @Matches(/^\d{4}$/, { message: 'mpin must be 4 digits' })
  mpin: string;
}

export class AdminCreateUserDto {
  @IsString()
  @MinLength(2, { message: 'Full name is required' })
  userName: string;

  @IsOptional()
  @ValidateIf((_, v) => v != null && String(v).trim() !== '')
  @IsEmail({}, { message: 'Invalid email' })
  email?: string;

  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;

  @IsString()
  @Length(4, 4, { message: 'password must be 4 digits' })
  @Matches(/^\d{4}$/, { message: 'password must be 4 digits' })
  mpin: string;

  @IsOptional()
  @IsIn(PARTNER_KYC_STATUSES)
  kycStatus?: PartnerKycStatus;
}

export class AdminUpdateUserDto {
  @IsOptional()
  @IsString()
  userName?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isLoggedIn?: boolean;

  @IsOptional()
  @IsIn(PARTNER_KYC_STATUSES)
  kycStatus?: PartnerKycStatus;
}

export class SubmitPartnerKycDto {
  @IsString()
  @Matches(/^\d{12}$/, { message: 'Aadhaar must be 12 digits' })
  aadhaarNumber: string;

  @IsString()
  @Matches(/^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/, { message: 'Enter a valid PAN' })
  pan: string;

  @IsString()
  @MinLength(2, { message: 'Bank name is required' })
  bankName: string;

  @IsString()
  @MinLength(2, { message: 'Account holder name is required' })
  accountHolder: string;

  @IsString()
  @Matches(/^\d{9,18}$/, { message: 'Enter a valid account number' })
  accountNumber: string;

  @IsString()
  @Matches(/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/, { message: 'Enter a valid IFSC' })
  ifsc: string;

  @Allow()
  aadhaarFront: unknown;

  @Allow()
  aadhaarBack: unknown;

  @Allow()
  panCard: unknown;

  @Allow()
  selfie: unknown;
}

export class AgentLoginDto {
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;

  @IsString()
  @Length(4, 4, { message: 'password must be 4 digits' })
  @Matches(/^\d{4}$/, { message: 'password must be 4 digits' })
  mpin: string;
}
