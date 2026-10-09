import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class StartWhatsappChatDto {
  @IsString()
  @MaxLength(20)
  phone!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text!: string;
}

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
}
