import { Transform } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsIn,
  IsNumber,
  MaxLength,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { FALLBACK_INSURANCE_TYPES, INS_TYPE_SLUG_PATTERN } from '../catalog/catalog';
import { isMaskedPan, PAN_FORMAT_REGEX } from '../security/pan-crypto';
import {
  CIBIL_BANDS,
  LEAD_FULL_NAME_REGEX,
  MIN_NET_MONTHLY_INCOME,
  STORED_EMPLOYMENT_TYPES,
} from './personal-loan-employment';
import { isStoredLoanCategory } from '../wallet/loan-amount';

/** Matches active service slugs stored as lead category (e.g. personal-loan → personal_loan). */
export const LEAD_CATEGORY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export { INS_TYPE_SLUG_PATTERN };

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

/** Fallback list when `insurance_types` is unavailable. New types come from DB. */
export const INS_TYPE_VALUES = FALLBACK_INSURANCE_TYPES.map((t) => t.value);

export const LEAD_STATUS_VALUES = [
  'pending',
  'kyc_progress',
  'in_process',
  'approved',
  'rejected',
] as const;

export class CreateLeadDto {
  /** Ignored on public create (referralCode only). Kept so old clients are not rejected. */
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

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(2, 255, { message: 'Full name must be 2–255 characters' })
  @Matches(LEAD_FULL_NAME_REGEX, {
    message: 'Name should not contain special characters or numbers',
  })
  fullName: string;

  @IsOptional()
  @IsString()
  email?: string;

  /** Public PL/insurance apply forms always send this (Indian 6-digit PIN). */
  @IsOptional()
  @IsString()
  @ValidateIf((o) => o.pincode != null && o.pincode !== '')
  @Length(6, 6, { message: 'Pincode must be 6 digits' })
  @Matches(/^[1-9][0-9]{5}$/, { message: 'Invalid Indian pincode (e.g. 302002)' })
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

  @ValidateIf((o) => o.category === 'insurance')
  @IsString({ message: 'Insurance type is required' })
  @Matches(INS_TYPE_SLUG_PATTERN, { message: 'Invalid insurance type' })
  insType?: string;

  /** Required on a loan. Old rows may still be `salaried`. */
  @ValidateIf((o) => isStoredLoanCategory(o.category))
  @IsIn([...STORED_EMPLOYMENT_TYPES], {
    message: 'Select salaried or self employee / business.',
  })
  employmentType?: string | null;

  @ValidateIf((o) => isStoredLoanCategory(o.category))
  @IsNumber({}, { message: 'Net monthly income is required' })
  @Min(MIN_NET_MONTHLY_INCOME, { message: 'Net monthly income must be at least ₹18,000' })
  netMonthlyIncome?: number;

  @ValidateIf((o) => isStoredLoanCategory(o.category))
  @IsIn([...CIBIL_BANDS], { message: 'Select your CIBIL score.' })
  cibilBand?: string;

  @ValidateIf((o) => isStoredLoanCategory(o.category))
  @Transform(({ value }) => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  })
  @IsBoolean({ message: 'Tell us if a loan EMI is already running.' })
  hasExistingEmi?: boolean;

  @ValidateIf((o) => isStoredLoanCategory(o.category))
  @IsNumber({}, { message: 'Enter the total monthly EMI you pay.' })
  @Min(0, { message: 'Total monthly EMI cannot be negative.' })
  totalMonthlyEmi?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  cibilReportName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  cibilReportMime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(280_000_000)
  cibilReportData?: string;

  @IsOptional()
  @IsString()
  @Length(6, 12)
  @Matches(/^[A-Za-z0-9]+$/, { message: 'Invalid referral code' })
  referralCode?: string;

  @IsOptional()
  @IsString()
  @MinLength(20)
  idToken?: string;

  /** Set by Next BFF from the visitor IP. */
  @IsOptional()
  @IsString()
  @Length(3, 45)
  clientIp?: string;

  /**
   * Lead-form checkbox: T&C, Privacy Policy, and contact permission.
   * Required on public apply. Omitted for CRM/partner creates (stored as false).
   */
  @IsBoolean()
  @Equals(true, {
    message: 'Please agree to the T&C and Privacy Policy to continue.',
  })
  consentAccepted?: boolean;
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
  @Matches(/^[1-9][0-9]{5}$/, { message: 'Invalid Indian pincode' })
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
  @IsIn([...LEAD_STATUS_VALUES], {
    message: `Status must be one of: ${LEAD_STATUS_VALUES.join(', ')}`,
  })
  status?: string;

  /** Personal loan: percentage 0.1–10. Insurance: fixed rupees 100–30000. */
  @IsOptional()
  @IsIn(['percentage', 'fixed'])
  commissionType?: 'percentage' | 'fixed' | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  commissionValue?: number | null;

  @IsOptional()
  @IsString()
  @ValidateIf((o) => o.clientIp != null && o.clientIp !== '')
  @Length(1, 45)
  clientIp?: string | null;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  @IsIn([...LOAN_AMT_VALUES], { message: 'Invalid loan amount range' })
  loanAmt?: string | null;

  @IsOptional()
  @IsString()
  @ValidateIf((o) => o.insType != null && o.insType !== '')
  @Matches(INS_TYPE_SLUG_PATTERN, { message: 'Invalid insurance type' })
  insType?: string | null;

  @IsOptional()
  @ValidateIf((o) => o.employmentType != null && o.employmentType !== '')
  @IsIn([...STORED_EMPLOYMENT_TYPES], {
    message: 'Select salaried or self employee / business.',
  })
  employmentType?: string | null;

  @IsOptional()
  @IsNumber()
  @ValidateIf((o) => o.netMonthlyIncome != null)
  @Min(MIN_NET_MONTHLY_INCOME, { message: 'Net monthly income must be at least ₹18,000' })
  netMonthlyIncome?: number | null;

  @IsOptional()
  @ValidateIf((o) => o.cibilBand != null && o.cibilBand !== '')
  @IsIn([...CIBIL_BANDS], { message: 'Select your CIBIL score.' })
  cibilBand?: string | null;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  })
  @IsBoolean()
  hasExistingEmi?: boolean | null;

  @IsOptional()
  @IsNumber()
  @ValidateIf((o) => o.totalMonthlyEmi != null)
  @Min(0)
  totalMonthlyEmi?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  cibilReportName?: string | null;

  @IsOptional()
  @IsString()
  agentId?: string;

  /** Internal: set after customer OTP (chat complete) or CRM. Not shown on public forms. */
  @IsOptional()
  @IsBoolean()
  otpVerified?: boolean;

  /** Set when a public apply upgrades an OTP draft after the consent checkbox. */
  @IsOptional()
  @IsBoolean()
  consentAccepted?: boolean;
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

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(2, 255, { message: 'Full name must be 2–255 characters' })
  @Matches(LEAD_FULL_NAME_REGEX, {
    message: 'Name should not contain special characters or numbers',
  })
  fullName: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  @ValidateIf((o) => o.pincode != null && o.pincode !== '')
  @Length(6, 6, { message: 'Pincode must be 6 digits' })
  @Matches(/^[1-9][0-9]{5}$/, { message: 'Invalid Indian pincode' })
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
  @IsIn([...LEAD_STATUS_VALUES], {
    message: `Status must be one of: ${LEAD_STATUS_VALUES.join(', ')}`,
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
  @ValidateIf((o) => o.insType != null && o.insType !== '')
  @Matches(INS_TYPE_SLUG_PATTERN, { message: 'Invalid insurance type' })
  insType?: string;

  @ValidateIf((o) => isStoredLoanCategory(o.category))
  @IsIn([...STORED_EMPLOYMENT_TYPES], {
    message: 'Select salaried or self employee / business.',
  })
  employmentType?: string | null;

  @ValidateIf((o) => isStoredLoanCategory(o.category))
  @IsNumber({}, { message: 'Net monthly income is required' })
  @Min(MIN_NET_MONTHLY_INCOME, { message: 'Net monthly income must be at least ₹18,000' })
  netMonthlyIncome?: number;

  @ValidateIf((o) => isStoredLoanCategory(o.category))
  @IsIn([...CIBIL_BANDS], { message: 'Select your CIBIL score.' })
  cibilBand?: string;

  @ValidateIf((o) => isStoredLoanCategory(o.category))
  @Transform(({ value }) => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  })
  @IsBoolean({ message: 'Tell us if a loan EMI is already running.' })
  hasExistingEmi?: boolean;

  @ValidateIf((o) => isStoredLoanCategory(o.category))
  @IsNumber({}, { message: 'Enter the total monthly EMI you pay.' })
  @Min(0, { message: 'Total monthly EMI cannot be negative.' })
  totalMonthlyEmi?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  cibilReportName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  cibilReportMime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(280_000_000)
  cibilReportData?: string;

  /** Ignored on admin/partner create. Those leads are stored with consent yes. */
  @IsOptional()
  @IsBoolean()
  consentAccepted?: boolean;

  /** Ignored. Admin and partner add-lead does not use a phone OTP. */
  @IsOptional()
  @IsString()
  idToken?: string;
}

export class RevealPanDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
