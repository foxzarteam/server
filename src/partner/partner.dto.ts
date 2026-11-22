import {
  IsOptional,
  IsString,
  MinLength,
  IsIn,
  IsNumber,
  Min,
  IsArray,
  MaxLength,
} from 'class-validator';
import { PARTNER_REQUIRED_DOCUMENTS } from './partner-documents';

export class AdminCreatePartnerDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsString()
  @MinLength(1)
  serviceId: string;

  @IsString()
  @IsIn(['PERCENTAGE', 'FLAT'], { message: 'payoutType must be PERCENTAGE or FLAT' })
  payoutType: string;

  @IsNumber()
  @Min(0)
  commissionValue: number;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  policy?: string;

  @IsOptional()
  @IsArray()
  @IsIn([...PARTNER_REQUIRED_DOCUMENTS], { each: true })
  requiredDocuments?: string[];
}

export class AdminUpdatePartnerDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  serviceId?: string;

  @IsOptional()
  @IsString()
  @IsIn(['PERCENTAGE', 'FLAT'], { message: 'payoutType must be PERCENTAGE or FLAT' })
  payoutType?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  commissionValue?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  policy?: string;

  @IsOptional()
  @IsArray()
  @IsIn([...PARTNER_REQUIRED_DOCUMENTS], { each: true })
  requiredDocuments?: string[];
}
