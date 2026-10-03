import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { TABLE_APP_SETTINGS } from '../common/constants';
import { SUPABASE_CLIENT } from '../config/supabase';
import { decryptSettingsJson, encryptSettingsJson } from './settings-crypto';
import { UpdateWhatsappSettingsDto } from './whatsapp.dto';

const SETTINGS_KEY = 'whatsapp_integration';
const GRAPH_VERSION = 'v21.0';

export type WhatsappSettings = {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId: string;
  appSecret: string;
  verifyToken: string;
  geminiApiKey: string;
  geminiModel: string;
  displayPhone: string;
};

export type WhatsappSettingsPublic = {
  accessTokenConfigured: boolean;
  accessTokenHint: string;
  phoneNumberId: string;
  businessAccountId: string;
  appSecretConfigured: boolean;
  appSecretHint: string;
  verifyTokenConfigured: boolean;
  verifyTokenHint: string;
  geminiApiKeyConfigured: boolean;
  geminiApiKeyHint: string;
  geminiModel: string;
  geminiModels: string[];
  displayPhone: string;
};

const EMPTY: WhatsappSettings = {
  accessToken: '',
  phoneNumberId: '',
  businessAccountId: '',
  appSecret: '',
  verifyToken: '',
  geminiApiKey: '',
  geminiModel: '',
  displayPhone: '',
};

function hint(value: string): string {
  const v = value.trim();
  if (!v) return '';
  if (v.length <= 4) return '••••';
  return `••••${v.slice(-4)}`;
}

function keep(next: string | undefined, prev: string): string {
  const value = String(next ?? '').trim();
  return value || prev;
}

/** Ignore blank or short values so a browser autofill cannot replace a saved API secret. */
function keepLongSecret(next: string | undefined, prev: string): string {
  const value = String(next ?? '').trim();
  if (value.length < 30) return prev;
  return value;
}

function cleanAccessToken(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^bearer\s+/i, '')
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

function cleanGeminiKey(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/\s+/g, '');
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

@Injectable()
export class WhatsappSettingsService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly config: ConfigService,
  ) {}

  async getStored(): Promise<WhatsappSettings> {
    const { data, error } = await this.supabase
      .from(TABLE_APP_SETTINGS)
      .select('value')
      .eq('key', SETTINGS_KEY)
      .maybeSingle();

    if (error) {
      console.error('WhatsappSettingsService.getStored', error.message);
      return { ...EMPTY };
    }
    const raw = String((data as { value?: string } | null)?.value ?? '');
    if (!raw) return { ...EMPTY };
    const parsed = decryptSettingsJson<Partial<WhatsappSettings>>(raw);
    if (!parsed) {
      console.error('WhatsappSettingsService.getStored: could not decrypt settings');
      return { ...EMPTY };
    }
    return { ...EMPTY, ...parsed };
  }

  /** DB value wins. Env is only a fallback so existing webhook tokens keep working. */
  async getEffective(): Promise<WhatsappSettings> {
    const stored = await this.getStored();
    const env = (name: string) => (this.config.get<string>(name) ?? '').trim();
    return {
      accessToken: cleanAccessToken(stored.accessToken || env('WHATSAPP_ACCESS_TOKEN')),
      phoneNumberId: stored.phoneNumberId || env('WHATSAPP_PHONE_NUMBER_ID'),
      businessAccountId: stored.businessAccountId || env('WHATSAPP_BUSINESS_ACCOUNT_ID'),
      appSecret: stored.appSecret || env('WHATSAPP_APP_SECRET'),
      verifyToken: stored.verifyToken || env('WHATSAPP_VERIFY_TOKEN'),
      geminiApiKey: cleanGeminiKey(stored.geminiApiKey || env('GEMINI_API_KEY')),
      geminiModel: stored.geminiModel || env('GEMINI_MODEL'),
      displayPhone: stored.displayPhone || digitsOnly(env('WHATSAPP_DISPLAY_PHONE')),
    };
  }

  toPublic(settings: WhatsappSettings): WhatsappSettingsPublic {
    return {
      accessTokenConfigured: Boolean(settings.accessToken),
      accessTokenHint: hint(settings.accessToken),
      phoneNumberId: settings.phoneNumberId,
      businessAccountId: settings.businessAccountId,
      appSecretConfigured: Boolean(settings.appSecret),
      appSecretHint: hint(settings.appSecret),
      verifyTokenConfigured: Boolean(settings.verifyToken),
      verifyTokenHint: hint(settings.verifyToken),
      geminiApiKeyConfigured: Boolean(settings.geminiApiKey),
      geminiApiKeyHint: hint(settings.geminiApiKey),
      geminiModel: settings.geminiModel,
      geminiModels: [],
      displayPhone: settings.displayPhone,
    };
  }

  async update(dto: UpdateWhatsappSettingsDto): Promise<{ settings: WhatsappSettings; warning?: string }> {
    const prev = await this.getStored();
    const next: WhatsappSettings = {
      accessToken: cleanAccessToken(keepLongSecret(dto.accessToken, prev.accessToken)),
      phoneNumberId: digitsOnly(keep(dto.phoneNumberId, prev.phoneNumberId)),
      businessAccountId: digitsOnly(keep(dto.businessAccountId, prev.businessAccountId)),
      appSecret: keepLongSecret(dto.appSecret, prev.appSecret),
      verifyToken: keep(dto.verifyToken, prev.verifyToken),
      geminiApiKey: cleanGeminiKey(keepLongSecret(dto.geminiApiKey, prev.geminiApiKey)),
      geminiModel: keep(dto.geminiModel, prev.geminiModel),
      displayPhone: prev.displayPhone,
    };

    this.assertShape(next);

    let warning: string | undefined;
    if (next.accessToken && next.phoneNumberId) {
      const lookedUp = await this.lookupDisplayPhone(next.phoneNumberId, next.accessToken);
      if (lookedUp) next.displayPhone = lookedUp;
      else warning = 'Saved, but the business phone number could not be read from Meta. Check the access token and phone number ID.';
    }

    const { error } = await this.supabase.from(TABLE_APP_SETTINGS).upsert(
      {
        key: SETTINGS_KEY,
        value: encryptSettingsJson(next),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'key' },
    );

    if (error) {
      console.error('WhatsappSettingsService.update', error.message);
      throw new BadRequestException('Could not save WhatsApp settings.');
    }

    return { settings: next, warning };
  }

  async setGeminiModel(model: string): Promise<WhatsappSettings> {
    const prev = await this.getStored();
    const next = { ...prev, geminiModel: model.trim() };
    this.assertShape(next);
    const { error } = await this.supabase.from(TABLE_APP_SETTINGS).upsert(
      {
        key: SETTINGS_KEY,
        value: encryptSettingsJson(next),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'key' },
    );
    if (error) {
      console.error('WhatsappSettingsService.setGeminiModel', error.message);
      throw new BadRequestException('Could not save WhatsApp settings.');
    }
    return next;
  }

  async rememberDisplayPhone(phone: string): Promise<void> {
    const digits = phone.replace(/\D/g, '');
    if (!/^[0-9]{8,15}$/.test(digits)) return;
    const prev = await this.getStored();
    if (prev.displayPhone === digits) return;
    if (!prev.accessToken && !prev.phoneNumberId) return;
    const next = { ...prev, displayPhone: digits };
    const { error } = await this.supabase.from(TABLE_APP_SETTINGS).upsert(
      {
        key: SETTINGS_KEY,
        value: encryptSettingsJson(next),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'key' },
    );
    if (error) console.error('WhatsappSettingsService.rememberDisplayPhone', error.message);
  }

  private assertShape(settings: WhatsappSettings) {
    if (settings.phoneNumberId && !/^\d{5,30}$/.test(settings.phoneNumberId)) {
      throw new BadRequestException('Phone number ID must be digits.');
    }
    if (settings.businessAccountId && !/^\d{5,30}$/.test(settings.businessAccountId)) {
      throw new BadRequestException('Business account ID must be digits.');
    }
    if (settings.geminiModel && !/^[A-Za-z0-9._-]{1,80}$/.test(settings.geminiModel)) {
      throw new BadRequestException('Gemini model name is not valid.');
    }
    if (settings.verifyToken && settings.verifyToken.length < 8) {
      throw new BadRequestException('Webhook verify token must be at least 8 characters.');
    }
  }

  async lookupDisplayPhone(phoneNumberId: string, accessToken: string): Promise<string> {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) return '';
      const data = (await res.json()) as { display_phone_number?: string };
      const digits = digitsOnly(String(data.display_phone_number ?? ''));
      if (digits.length === 10 && /^[6-9]/.test(digits)) return `91${digits}`;
      if (digits.length >= 8 && digits.length <= 15) return digits;
      return '';
    } catch {
      return '';
    }
  }
}
