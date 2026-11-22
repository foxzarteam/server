import {
  IsOptional,
  IsString,
  MinLength,
  IsIn,
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

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  policy?: string;

  @IsOptional()
  @IsArray()
  @IsIn([...PARTNER_REQUIRED_DOCUMENTS], { each: true })
  requiredDocuments?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  utmLink?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  imagePath?: string;
}

export class AdminUploadPartnerImageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  filename: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  mimeType?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(3_000_000)
  contentBase64: string;
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
  @MaxLength(20000)
  policy?: string;

  @IsOptional()
  @IsArray()
  @IsIn([...PARTNER_REQUIRED_DOCUMENTS], { each: true })
  requiredDocuments?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  utmLink?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  imagePath?: string;
}
