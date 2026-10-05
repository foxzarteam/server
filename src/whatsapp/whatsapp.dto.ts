import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateWhatsappSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  accessToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phoneNumberId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  businessAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  appSecret?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  verifyToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  geminiApiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  geminiModel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  groqApiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  groqModel?: string;
}
