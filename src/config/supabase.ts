import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export const SUPABASE_CLIENT = 'SUPABASE_CLIENT';

export function createSupabaseClient(config: ConfigService): SupabaseClient {
  const url = config.get<string>('SUPABASE_URL');
  const key =
    config.get<string>('SUPABASE_SERVICE_KEY')?.trim() ||
    config.get<string>('SUPABASE_SERVICE_ROLE_KEY')?.trim();
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) must be set in .env');
  }
  if (/^sb_publishable_/i.test(key) || /^sb_anon_/i.test(key)) {
    throw new Error(
      'SUPABASE_SERVICE_KEY is a publishable/anon key. Use the service_role secret from Supabase → Settings → API (JWT, usually starts with eyJ). Inserts such as Add agent will fail otherwise.',
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

@Global()
@Module({
  providers: [
    {
      provide: SUPABASE_CLIENT,
      useFactory: (config: ConfigService): SupabaseClient => createSupabaseClient(config),
      inject: [ConfigService],
    },
  ],
  exports: [SUPABASE_CLIENT],
})
export class SupabaseModule {}
