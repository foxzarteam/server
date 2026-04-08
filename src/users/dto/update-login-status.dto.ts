import { IsBoolean } from 'class-validator';

export class UpdateLoginStatusDto {
  @IsBoolean()
  isLoggedIn: boolean;
}
