import {
  IsOptional,
  IsString,
  Length,
  MinLength,
  IsIn,
  IsNumber,
  Min,
} from 'class-validator';

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
}
