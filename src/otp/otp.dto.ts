import { IsBoolean, IsOptional, IsString, Length, Matches, MinLength } from 'class-validator';

export class SendOtpDto {
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;

  /** Web: check daily limit without inserting a send row. */
  @IsOptional()
  @IsBoolean()
  checkOnly?: boolean;
}

export class VerifyFirebaseOtpDto {
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;

  @IsString()
  @MinLength(20, { message: 'idToken is required' })
  idToken: string;
}

export type OtpResult = {
  success: boolean;
  message: string;
  remainingSends?: number;
  /** True when daily limit hit — allow again next calendar day (IST). */
  retryNextDay?: boolean;
};
