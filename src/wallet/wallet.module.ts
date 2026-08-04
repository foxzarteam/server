import { Module } from '@nestjs/common';
import { OtpModule } from '../otp/otp.module';
import { UsersModule } from '../users/users.module';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

@Module({
  imports: [UsersModule, OtpModule],
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}

export { WalletService } from './wallet.service';
export { WalletController } from './wallet.controller';
