import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
  MinLength,
  ValidateIf,
  } from 'class-validator';

export class CreateUserDto {
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;

  @IsOptional()
  @IsString()
  userName?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(20)
  idToken?: string;
}

export class UpsertUserDto {
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;

  @IsOptional()
  @IsString()
  userName?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  @Length(4, 4, { message: 'mpin must be 4 digits' })
  @Matches(/^\d{4}$/, { message: 'mpin must be 4 digits' })
  mpin?: string;

  @IsOptional()
  @IsBoolean()
  isLoggedIn?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(20)
  idToken?: string;
}

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  userName?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(20)
  idToken?: string;
}

export class UpdateMpinDto {
  @IsString()
  @Length(4, 4, { message: 'mpin must be 4 digits' })
  @Matches(/^\d{4}$/, { message: 'mpin must be 4 digits' })
  mpin: string;

  @IsOptional()
  @IsString()
  @MinLength(20)
  idToken?: string;
}

export class VerifyMpinDto {
  @IsString()
  @Length(4, 4, { message: 'mpin must be 4 digits' })
  @Matches(/^\d{4}$/, { message: 'mpin must be 4 digits' })
  mpin: string;

  @IsOptional()
  @IsString()
  @MinLength(20)
  idToken?: string;
}

export class UpdateLoginStatusDto {
  @IsBoolean()
  isLoggedIn: boolean;

  @IsOptional()
  @IsString()
  @MinLength(20)
  idToken?: string;
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
}

export const MPIN_LENGTH = 4;
export const DEFAULT_USER_NAME = 'User';

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
