import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}

export { AuthService } from './auth.service';
export { AuthController } from './auth.controller';
export {
  AdminLoginDto,
} from './auth.dto';
