import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpsertPaymentAccountDto {
  @IsString()
  @IsIn(['upi', 'bank'])
  paymentType: 'upi' | 'bank';

  @IsOptional()
  @IsString()
  @MaxLength(255)
  upiId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  bankName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  ifscCode?: string;
}
