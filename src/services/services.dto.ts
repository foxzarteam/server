import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import type { InsuranceTypePublic } from '../catalog/catalog';

export type { InsuranceTypePublic } from '../catalog/catalog';

export type ServicePublic = {
  id: string;
  slug: string;
  title: string;
  description: string;
  imageUrl: string;
  sortOrder: number;
  isActive: boolean;
  limitStart: number | null;
  limitEnd: number | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicCatalog = {
  services: ServicePublic[];
  insuranceTypes: InsuranceTypePublic[];
};

export class AdminUpdateServiceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  slug?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Transform(({ value }) => optionalRupee(value))
  @ValidateIf((_obj, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(100_00_00_000)
  limitStart?: number | null;

  @IsOptional()
  @Transform(({ value }) => optionalRupee(value))
  @ValidateIf((_obj, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(100_00_00_000)
  limitEnd?: number | null;
}

function optionalRupee(value: unknown): number | null | unknown {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return value;
}
