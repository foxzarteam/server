import { Module } from '@nestjs/common';
import { AdminCrmGuard, AdminOnlyGuard } from '../common/admin-crm.guard';
import { OtpModule } from '../otp/otp.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [OtpModule],
  controllers: [UsersController],
  providers: [UsersService, AdminCrmGuard, AdminOnlyGuard],
  exports: [UsersService],
})
export class UsersModule {}

export { UsersService } from './users.service';
export { UsersController } from './users.controller';
export {
  CreateUserDto,
  UpsertUserDto,
  UpdateProfileDto,
  UpdateMpinDto,
  VerifyMpinDto,
  UpdateLoginStatusDto,
  AdminUpdateUserDto,
  AdminCreateUserDto,
} from './users.dto';
