import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
  ValidateIf,
} from 'class-validator';
import { isMaskedPan, PAN_FORMAT_REGEX } from '../security/pan-crypto';

/** Matches active service slugs stored as lead category (e.g. personal-loan → personal_loan). */
export const LEAD_CATEGORY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const LOAN_AMT_VALUES = [
  '25000_100000',
  '100000_200000',
  '200000_300000',
  '300000_400000',
  '400000_500000',
  '500000_600000',
  '600000_700000',
  '700000_800000',
  '800000_900000',
  '900000_1000000',
] as const;

export const INS_TYPE_VALUES = [
  'life_insurance',
  'health_insurance',
  'motor_insurance',
] as const;

export const EMPLOYMENT_TYPE_VALUES = ['salaried', 'self_employed'] as const;

export class StartLeadDto {
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;

  @IsOptional()
  @IsString()
  @Matches(LEAD_CATEGORY_PATTERN, { message: 'Invalid category' })
  category?: string;
}

export class CompleteLeadDto {
  @IsString()
  @Length(10, 10, { message: 'PAN must be 10 characters' })
  @Matches(PAN_FORMAT_REGEX, { message: 'Invalid PAN format (e.g. ABCDE1234F)' })
  pan: string;

  @IsString()
  fullName: string;

  @IsOptional()
  @IsString()
  @Matches(LEAD_CATEGORY_PATTERN, { message: 'Invalid category' })
  category?: string;

  /** Exact loan amount in rupees (chat / personal loan form). */
  @IsOptional()
  @IsNumber()
  @ValidateIf((o) => o.requiredAmount != null)
  @Min(0, { message: 'Required amount must be positive' })
  requiredAmount?: number;

  @IsOptional()
  @IsString()
  @IsIn([...LOAN_AMT_VALUES], { message: 'Invalid loan amount range' })
  loanAmt?: string;

  @IsOptional()
  @IsString()
  @IsIn([...INS_TYPE_VALUES], { message: 'Invalid insurance type' })
  insType?: string;

  /** Required when category is personal_loan */
  @ValidateIf((o) => (o.category ?? 'personal_loan') === 'personal_loan')
  @IsString({ message: 'Employment type is required for personal loan' })
  @IsIn([...EMPLOYMENT_TYPE_VALUES], { message: 'Invalid employment type' })
  employmentType?: string;

  @ValidateIf((o) => (o.category ?? 'personal_loan') === 'personal_loan')
  @IsNumber({}, { message: 'Net monthly income is required for personal loan' })
  @Min(1, { message: 'Net monthly income must be at least 1' })
  netMonthlyIncome?: number;
}

export class CreateLeadDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsString()
  @Length(10, 10, { message: 'PAN must be 10 characters' })
  @Matches(PAN_FORMAT_REGEX, { message: 'Invalid PAN format (e.g. ABCDE1234F)' })
  pan: string;

  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;

  @IsString()
  fullName: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  @ValidateIf((o) => o.pincode != null && o.pincode !== '')
  @Length(6, 6, { message: 'Pincode must be 6 digits' })
  pincode?: string;

  @IsOptional()
  @IsNumber()
  @ValidateIf((o) => o.requiredAmount != null)
  @Min(0, { message: 'Required amount must be positive' })
  requiredAmount?: number;

  @IsString()
  @Matches(LEAD_CATEGORY_PATTERN, {
    message: 'Invalid category (use service slug with underscores, e.g. personal_loan)',
  })
  category: string;

  @IsOptional()
  @IsString()
  @IsIn([...LOAN_AMT_VALUES], { message: 'Invalid loan amount range' })
  loanAmt?: string;

  @IsOptional()
  @IsString()
  @IsIn([...INS_TYPE_VALUES], { message: 'Invalid insurance type' })
  insType?: string;

  /** Required when category is personal_loan */
  @ValidateIf((o) => o.category === 'personal_loan')
  @IsString({ message: 'Employment type is required for personal loan' })
  @IsIn([...EMPLOYMENT_TYPE_VALUES], { message: 'Invalid employment type' })
  employmentType?: string;

  @ValidateIf((o) => o.category === 'personal_loan')
  @IsNumber({}, { message: 'Net monthly income is required for personal loan' })
  @Min(1, { message: 'Net monthly income must be at least 1' })
  netMonthlyIncome?: number;
}

export class UpdateLeadDto {
  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber?: string;

  @IsOptional()
  @IsString()
  @ValidateIf((o) => o.pan != null && o.pan !== '' && !isMaskedPan(String(o.pan)))
  @Length(10, 10, { message: 'PAN must be 10 characters' })
  @Matches(PAN_FORMAT_REGEX, { message: 'Invalid PAN format (e.g. ABCDE1234F)' })
  pan?: string;

  @IsOptional()
  @IsString()
  @ValidateIf((o) => o.pincode != null && o.pincode !== '')
  @Length(6, 6, { message: 'Pincode must be 6 digits' })
  pincode?: string;

  @IsOptional()
  @IsNumber()
  @ValidateIf((o) => o.requiredAmount != null)
  @Min(0, { message: 'Required amount must be positive' })
  requiredAmount?: number | null;

  @IsOptional()
  @IsString()
  @Matches(LEAD_CATEGORY_PATTERN, { message: 'Invalid category' })
  category?: string;

  @IsOptional()
  @IsString()
  @IsIn(['pending', 'approved', 'rejected'], {
    message: 'Status must be one of: pending, approved, rejected',
  })
  status?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  @IsIn([...LOAN_AMT_VALUES], { message: 'Invalid loan amount range' })
  loanAmt?: string | null;

  @IsOptional()
  @IsString()
  @IsIn([...INS_TYPE_VALUES], { message: 'Invalid insurance type' })
  insType?: string | null;

  @IsOptional()
  @IsString()
  @IsIn([...EMPLOYMENT_TYPE_VALUES], { message: 'Invalid employment type' })
  employmentType?: string | null;

  @IsOptional()
  @IsNumber()
  @ValidateIf((o) => o.netMonthlyIncome != null)
  @Min(0, { message: 'Net monthly income must be positive' })
  netMonthlyIncome?: number | null;
}

/** Admin CRM — create lead with optional status/notes. */
export class AdminCreateLeadDto {
  @IsString()
  @Length(10, 10, { message: 'PAN must be 10 characters' })
  @Matches(PAN_FORMAT_REGEX, { message: 'Invalid PAN format (e.g. ABCDE1234F)' })
  pan: string;

  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;

  @IsString()
  fullName: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  @ValidateIf((o) => o.pincode != null && o.pincode !== '')
  @Length(6, 6, { message: 'Pincode must be 6 digits' })
  pincode?: string;

  @IsOptional()
  @IsNumber()
  @ValidateIf((o) => o.requiredAmount != null)
  @Min(0, { message: 'Required amount must be positive' })
  requiredAmount?: number;

  @IsString()
  @Matches(LEAD_CATEGORY_PATTERN, {
    message: 'Invalid category (use service slug with underscores, e.g. personal_loan)',
  })
  category: string;

  @IsOptional()
  @IsString()
  @IsIn(['pending', 'approved', 'rejected'], {
    message: 'Status must be one of: pending, approved, rejected',
  })
  status?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  @IsIn([...LOAN_AMT_VALUES], { message: 'Invalid loan amount range' })
  loanAmt?: string;

  @IsOptional()
  @IsString()
  @IsIn([...INS_TYPE_VALUES], { message: 'Invalid insurance type' })
  insType?: string;

  /** Required when category is personal_loan */
  @ValidateIf((o) => o.category === 'personal_loan')
  @IsString({ message: 'Employment type is required for personal loan' })
  @IsIn([...EMPLOYMENT_TYPE_VALUES], { message: 'Invalid employment type' })
  employmentType?: string;

  @ValidateIf((o) => o.category === 'personal_loan')
  @IsNumber({}, { message: 'Net monthly income is required for personal loan' })
  @Min(1, { message: 'Net monthly income must be at least 1' })
  netMonthlyIncome?: number;
}

export class RevealPanDto {
  @IsOptional()
  @IsString()
  adminId?: string;

  @IsOptional()
  @IsString()
  adminEmail?: string;

  @IsOptional()
  @IsString()
  adminRole?: string;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  ipAddress?: string;

  @IsOptional()
  @IsString()
  userAgent?: string;
}
