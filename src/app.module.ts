import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { PublicExceptionFilter } from './common/public-exception.filter';
import { SupabaseModule } from './config/supabase';
import { HealthModule } from './health.module';
import { DocsModule } from './docs/docs.module';
import { UsersModule } from './users/users.module';
import { OtpModule } from './otp/otp.module';
import { LeadsModule } from './leads/leads.module';
import { BannersModule } from './banners/banners.module';
import { ServicesModule } from './services/services.module';
import { PaymentAccountsModule } from './payment-accounts/payment-accounts.module';
import { WalletModule } from './wallet/wallet.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { PartnerModule } from './partner/partner.module';
import { CustomerModule } from './customer/customer.module';
import { ContactModule } from './contact/contact.module';
import { ChatModule } from './chat/chat.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    HealthModule,
    DocsModule,
    SupabaseModule,
    UsersModule,
    OtpModule,
    LeadsModule,
    BannersModule,
    ServicesModule,
    PaymentAccountsModule,
    WalletModule,
    AuthModule,
    AdminModule,
    PartnerModule,
    CustomerModule,
    ContactModule,
    ChatModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: PublicExceptionFilter }],
})
export class AppModule {}
