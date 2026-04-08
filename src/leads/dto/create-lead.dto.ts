import { IsString, IsOptional, IsNumber, IsIn, Matches, Length, Min, ValidateIf } from 'class-validator';

export class CreateLeadDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsString()
  @Length(10, 10, { message: 'PAN must be 10 characters' })
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
  @IsIn(
    [
      'personal_loan',
      'home_loan',
      'business_loan',
      'credit_card',
      'insurance',
      'vehicle_loan',
    ],
    {
      message:
        'Category must be one of: personal_loan, home_loan, business_loan, credit_card, insurance, vehicle_loan',
    },
  )
  category: string;
}
