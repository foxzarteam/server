import {
  IsOptional,
  IsString,
  Length,
  Matches,
  MinLength,
  IsIn,
  IsEmail,
  Min,
} from 'class-validator';

const CONTACT_STATUSES = ['new', 'read', 'replied', 'archived'] as const;

export class CreateContactDto {
  @IsString()
  @MinLength(2, { message: 'Please enter your name.' })
  name: string;

  @IsEmail({}, { message: 'Please enter a valid email.' })
  email: string;

  @IsString()
  @Length(10, 10, { message: 'Please enter a valid 10-digit mobile number.' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Please enter a valid 10-digit mobile number.' })
  phone: string;

  @IsString()
  @MinLength(3, { message: 'Please enter a message.' })
  message: string;
}

export class UpdateContactDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @Length(10, 10)
  @Matches(/^[6-9]\d{9}$/)
  phone?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  message?: string;

  @IsOptional()
  @IsString()
  @IsIn([...CONTACT_STATUSES])
  status?: string;
}
