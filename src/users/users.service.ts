import { randomBytes } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { hashMpin, mpinMatches, sanitizeUserPublic, storedMpinLooksBcrypt } from '../common/mpin';
import { toPublicErrorMessage } from '../common/public-error';
import { SUPABASE_CLIENT } from '../config/supabase';
import { r2GetObject, r2PutObject } from '../storage/r2';
import { TABLE_PARTNER_KYC, TABLE_USERS, TABLE_WALLET, getCurrentIsoTime } from '../common/constants';
import {
  AdminCreateUserDto,
  AdminUpdateUserDto,
  PARTNER_KYC_STATUSES,
  SubmitPartnerKycDto,
  UpdateProfileDto,
  type PartnerKycStatus,
} from './users.dto';

const KYC_MAX_BYTES = 2 * 1024 * 1024;
const KYC_FILE_KINDS = ['aadhaarFront', 'aadhaarBack', 'panCard', 'selfie'] as const;
type KycFileKind = (typeof KYC_FILE_KINDS)[number];

function isMissingColumn(message: string, column: string): boolean {
  const text = message.toLowerCase();
  return text.includes(column.toLowerCase()) && (text.includes('does not exist') || text.includes('schema cache') || text.includes('could not find'));
}

function normalizeKycStatus(raw: unknown): PartnerKycStatus {
  const value = String(raw ?? '').trim().toLowerCase();
  if ((PARTNER_KYC_STATUSES as readonly string[]).includes(value)) {
    return value as PartnerKycStatus;
  }
  return 'approved';
}

function maskLast4(raw: string): string {
  const value = raw.replace(/\s/g, '');
  if (value.length < 4) return '****';
  return `${'X'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
}

function fileExt(file: { buffer: Buffer; filename: string; mimeType: string }): string | null {
  const mime = file.mimeType.toLowerCase();
  const name = file.filename.toLowerCase();
  if (mime.includes('pdf') || name.endsWith('.pdf')) return 'pdf';
  if (mime.includes('jpeg') || mime.includes('jpg') || name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'jpg';
  if (mime.includes('png') || name.endsWith('.png')) return 'png';
  if (mime.includes('webp') || name.endsWith('.webp')) return 'webp';
  const buf = file.buffer;
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === '%PDF') return 'pdf';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.length >= 2 && buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }
  return null;
}

function parseKycFile(raw: unknown, label: string): { buffer: Buffer; filename: string; mimeType: string } {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${label} is required`);
  }
  const obj = raw as Record<string, unknown>;
  const filename = String(obj.filename ?? 'file').trim() || 'file';
  const mimeType = String(obj.mimeType ?? '').trim();
  const content = String(obj.contentBase64 ?? '').replace(/\s/g, '');
  if (!content) throw new Error(`${label} is required`);
  const buffer = Buffer.from(content, 'base64');
  if (!buffer.length) throw new Error(`${label} is required`);
  if (buffer.length > KYC_MAX_BYTES) throw new Error(`${label} must be 2 MB or smaller`);
  return { buffer, filename, mimeType };
}

@Injectable()
export class UsersService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  private get users() {
    return this.supabase.from(TABLE_USERS);
  }

  /** Ensure public.wallet row exists for this user (INR zeros if new). */
  private async ensureWalletRow(userId: string): Promise<void> {
    const uid = String(userId ?? '').trim();
    if (!uid) return;
    const { data } = await this.supabase
      .from(TABLE_WALLET)
      .select('id')
      .eq('user_id', uid)
      .maybeSingle();
    if (data) return;
    const now = getCurrentIsoTime();
    const { error } = await this.supabase.from(TABLE_WALLET).insert({
      user_id: uid,
      earning: 0,
      redeem: 0,
      balance: 0,
      currency: 'INR',
      created_at: now,
      updated_at: now,
    });
    if (error && process.env.NODE_ENV !== 'production') {
      console.error('UsersService.ensureWalletRow', error);
    }
  }

  private newReferralCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(8);
    let out = '';
    for (let i = 0; i < 8; i++) out += alphabet[bytes[i]! % alphabet.length];
    return out;
  }

  async generateUniqueReferralCode(): Promise<string> {
    for (let i = 0; i < 12; i++) {
      const code = this.newReferralCode();
      const { data } = await this.users.select('id').eq('referral_code', code).maybeSingle();
      if (!data) return code;
    }
    return this.newReferralCode() + this.newReferralCode().slice(0, 2);
  }

  async ensureReferralCode(row: Record<string, unknown>): Promise<Record<string, unknown>> {
    const existing = String(row.referral_code ?? '').trim();
    if (existing) return row;
    const id = String(row.id ?? '').trim();
    if (!id) return row;
    const code = await this.generateUniqueReferralCode();
    const { data, error } = await this.users
      .update({ referral_code: code, updated_at: getCurrentIsoTime() })
      .eq('id', id)
      .select()
      .single();
    if (error || !data) return { ...row, referral_code: code };
    return data as Record<string, unknown>;
  }

  async getIdByReferralCode(code: string | undefined): Promise<string | null> {
    const c = String(code ?? '').trim().toUpperCase();
    if (c.length < 6) return null;
    const { data, error } = await this.users.select('id').eq('referral_code', c).maybeSingle();
    if (error || !data) return null;
    const id = String((data as { id?: string }).id ?? '').trim();
    return id || null;
  }

  async loginAgent(mobile: string, mpin: string): Promise<Record<string, unknown> | null> {
    const user = await this.getByMobile(mobile);
    if (!user || user.is_active === false) return null;
    const ok = await this.verifyMpin(mobile, mpin);
    if (!ok) return null;
    const withCode = await this.ensureReferralCode(user);
    await this.ensureWalletRow(String(withCode.id ?? ''));
    await this.users
      .update({
        is_logged_in: true,
        last_login_at: getCurrentIsoTime(),
        updated_at: getCurrentIsoTime(),
      })
      .eq('id', String(withCode.id ?? ''));
    return sanitizeUserPublic(withCode);
  }

  async getByMobile(mobile: string): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.users
      .select()
      .eq('mobile_number', mobile)
      .maybeSingle();
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.getByMobile', error);
      }
      return null;
    }
    return data as Record<string, unknown> | null;
  }

  async getById(id: string): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.users.select().eq('id', id.trim()).maybeSingle();
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.getById', error);
      }
      return null;
    }
    return data as Record<string, unknown> | null;
  }

  async createForAdmin(
    dto: AdminCreateUserDto,
  ): Promise<{ ok: true; user: Record<string, unknown> } | { ok: false; duplicate: boolean; message: string }> {
    const { data: existing, error: lookupError } = await this.users
      .select('id')
      .eq('mobile_number', dto.mobileNumber)
      .maybeSingle();

    if (lookupError) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.createForAdmin lookup', lookupError);
      }
      return {
        ok: false,
        duplicate: false,
        message: toPublicErrorMessage(lookupError.message, 'Could not create account. Please try again.'),
      };
    }
    if (existing) {
      return {
        ok: false,
        duplicate: true,
        message: 'This phone number is already registered. Please log in.',
      };
    }

    const email = dto.email?.trim() || null;
    const [referralCode, mpinHash] = await Promise.all([
      this.generateUniqueReferralCode(),
      hashMpin(dto.mpin),
    ]);
    const row: Record<string, unknown> = {
      mobile_number: dto.mobileNumber,
      user_name: dto.userName.trim(),
      email,
      mpin: mpinHash,
      referral_code: referralCode,
      is_active: true,
      is_logged_in: false,
      kyc_status: dto.kycStatus ?? 'pending',
    };
    let { data, error } = await this.users.insert(row).select().single();
    if (error && isMissingColumn(error.message ?? '', 'kyc_status')) {
      delete row.kyc_status;
      ({ data, error } = await this.users.insert(row).select().single());
    }
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.createForAdmin', error);
      }
      return {
        ok: false,
        duplicate: false,
        message: toPublicErrorMessage(error.message, 'Could not create account. Please try again.'),
      };
    }
    const user = sanitizeUserPublic(data as Record<string, unknown>);
    if (!user) {
      return { ok: false, duplicate: false, message: 'Could not create account. Please try again.' };
    }
    // Don't block register response on wallet row (created on first earnings fetch if missing).
    void this.ensureWalletRow(String(user.id ?? ''));
    return { ok: true, user };
  }

  async updateMpin(mobile: string, plainMpin: string): Promise<boolean> {
    const hashed = await hashMpin(plainMpin);
    const { error } = await this.users
      .update({
        mpin: hashed,
        updated_at: getCurrentIsoTime(),
      })
      .eq('mobile_number', mobile);
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.updateMpin', error);
      }
      return false;
    }
    return true;
  }

  async verifyMpin(mobile: string, plain: string): Promise<boolean> {
    const user = await this.getByMobile(mobile);
    if (!user) return false;
    const stored = String(user.mpin ?? '');
    if (!(await mpinMatches(plain, stored))) return false;
    if (stored && !storedMpinLooksBcrypt(stored)) {
      await this.updateMpin(mobile, plain);
    }
    return true;
  }

  async getAll(): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.users.select().order('created_at', { ascending: false });

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.getAll', error);
      }
      return [];
    }

    return ((data as Record<string, unknown>[]) || []).map(
      (row) => sanitizeUserPublic(row) as Record<string, unknown>,
    );
  }

  async updateById(id: string, dto: AdminUpdateUserDto): Promise<Record<string, unknown> | null> {
    const now = getCurrentIsoTime();
    const payload: Record<string, unknown> = { updated_at: now };

    if (dto.userName != null) payload.user_name = dto.userName.trim();
    if (dto.email !== undefined) payload.email = dto.email?.trim() || null;
    if (dto.mobileNumber != null) payload.mobile_number = dto.mobileNumber.trim();
    if (dto.isActive != null) payload.is_active = dto.isActive;
    if (dto.isLoggedIn != null) {
      payload.is_logged_in = dto.isLoggedIn;
      if (dto.isLoggedIn) payload.last_login_at = now;
    }
    if (dto.kycStatus != null) {
      payload.kyc_status = dto.kycStatus;
      if (dto.kycStatus === 'approved' || dto.kycStatus === 'rejected') {
        payload.updated_at = now;
      }
    }

    if (Object.keys(payload).length === 1) return null;

    let { data, error } = await this.users.update(payload).eq('id', id).select().single();
    if (error && isMissingColumn(error.message ?? '', 'kyc_status') && 'kyc_status' in payload) {
      delete payload.kyc_status;
      if (Object.keys(payload).length === 1) return null;
      ({ data, error } = await this.users.update(payload).eq('id', id).select().single());
    }

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.updateById', error);
      }
      return null;
    }

    const user = sanitizeUserPublic(data as Record<string, unknown>);
    if (user && (dto.kycStatus === 'approved' || dto.kycStatus === 'rejected')) {
      await this.supabase
        .from(TABLE_PARTNER_KYC)
        .update({ reviewed_at: now })
        .eq('user_id', id);
    }
    return user;
  }

  async updateProfileById(
    id: string,
    dto: UpdateProfileDto,
  ): Promise<Record<string, unknown> | null> {
    const uid = id.trim();
    if (!uid) return null;
    const payload: Record<string, unknown> = {
      updated_at: getCurrentIsoTime(),
    };
    if (dto.userName != null) payload.user_name = dto.userName.trim();
    if (dto.email !== undefined) payload.email = dto.email?.trim() || null;
    if (Object.keys(payload).length === 1) {
      const existing = await this.getById(uid);
      return existing ? sanitizeUserPublic(existing) : null;
    }
    const { data, error } = await this.users.update(payload).eq('id', uid).select().single();
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.updateProfileById', error);
      }
      return null;
    }
    return sanitizeUserPublic(data as Record<string, unknown>);
  }

  /**
   * Drop wallet earning/redeem/balance for this partner.
   * wallet.user_id has no FK cascade, so a user delete would otherwise leave the row.
   */
  private async deleteWalletForUser(userId: string): Promise<boolean> {
    const { error } = await this.supabase.from(TABLE_WALLET).delete().eq('user_id', userId);
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.deleteWalletForUser', error);
      }
      return false;
    }
    return true;
  }

  async deleteById(id: string): Promise<boolean> {
    const uid = id.trim();
    if (!uid) return false;

    // Clear wallet first so leftover earning cannot outlive the partner.
    const walletCleared = await this.deleteWalletForUser(uid);
    if (!walletCleared) return false;

    const { error } = await this.users.delete().eq('id', uid);

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.deleteById', error);
      }
      return false;
    }

    return true;
  }

  kycStatusOf(user: Record<string, unknown> | null): PartnerKycStatus {
    return normalizeKycStatus(user?.kyc_status);
  }

  async getKycStatus(userId: string): Promise<{
    kyc_status: PartnerKycStatus;
    can_submit: boolean;
  }> {
    const user = await this.getById(userId);
    const kyc_status = this.kycStatusOf(user);
    return {
      kyc_status,
      can_submit: kyc_status === 'pending' || kyc_status === 'rejected',
    };
  }

  async getKycForAdmin(userId: string): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.supabase
      .from(TABLE_PARTNER_KYC)
      .select()
      .eq('user_id', userId.trim())
      .maybeSingle();
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.getKycForAdmin', error);
      }
      return null;
    }
    if (!data) return null;
    const row = data as Record<string, unknown>;
    return {
      user_id: row.user_id,
      aadhaar_number: maskLast4(String(row.aadhaar_number ?? '')),
      pan: String(row.pan ?? ''),
      bank_name: String(row.bank_name ?? ''),
      account_holder: String(row.account_holder ?? ''),
      account_number: maskLast4(String(row.account_number ?? '')),
      ifsc: String(row.ifsc ?? ''),
      submitted_at: row.submitted_at,
      reviewed_at: row.reviewed_at,
      files: {
        aadhaarFront: Boolean(row.aadhaar_front_path),
        aadhaarBack: Boolean(row.aadhaar_back_path),
        panCard: Boolean(row.pan_card_path),
        selfie: Boolean(row.selfie_path),
      },
    };
  }

  async getKycFile(
    userId: string,
    kind: string,
  ): Promise<{ ok: true; body: Buffer; contentType: string } | { ok: false }> {
    if (!(KYC_FILE_KINDS as readonly string[]).includes(kind)) return { ok: false };
    const { data, error } = await this.supabase
      .from(TABLE_PARTNER_KYC)
      .select('aadhaar_front_path, aadhaar_back_path, pan_card_path, selfie_path')
      .eq('user_id', userId.trim())
      .maybeSingle();
    if (error || !data) return { ok: false };
    const row = data as Record<string, unknown>;
    const pathMap: Record<KycFileKind, string> = {
      aadhaarFront: String(row.aadhaar_front_path ?? ''),
      aadhaarBack: String(row.aadhaar_back_path ?? ''),
      panCard: String(row.pan_card_path ?? ''),
      selfie: String(row.selfie_path ?? ''),
    };
    const stored = pathMap[kind as KycFileKind].trim();
    if (!stored) return { ok: false };
    const key = stored.replace(/^https?:\/\/[^/]+\//, '').replace(/^\/+/, '');
    return r2GetObject(key);
  }

  async submitPartnerKyc(
    userId: string,
    dto: SubmitPartnerKycDto,
  ): Promise<{ ok: true; kyc_status: PartnerKycStatus } | { ok: false; error: string }> {
    const uid = userId.trim();
    if (!uid) return { ok: false, error: 'Unauthorized' };
    const user = await this.getById(uid);
    if (!user) return { ok: false, error: 'Account not found' };
    const current = this.kycStatusOf(user);
    if (current !== 'pending' && current !== 'rejected') {
      return { ok: false, error: 'KYC is already submitted. Wait for admin review.' };
    }

    let aadhaarFront;
    let aadhaarBack;
    let panCard;
    let selfie;
    try {
      aadhaarFront = parseKycFile(dto.aadhaarFront, 'Aadhaar front');
      aadhaarBack = parseKycFile(dto.aadhaarBack, 'Aadhaar back');
      panCard = parseKycFile(dto.panCard, 'PAN card');
      selfie = parseKycFile(dto.selfie, 'Selfie');
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Upload the required documents' };
    }

    const uploads: { kind: KycFileKind; file: ReturnType<typeof parseKycFile> }[] = [
      { kind: 'aadhaarFront', file: aadhaarFront },
      { kind: 'aadhaarBack', file: aadhaarBack },
      { kind: 'panCard', file: panCard },
      { kind: 'selfie', file: selfie },
    ];
    const paths: Record<KycFileKind, string> = {
      aadhaarFront: '',
      aadhaarBack: '',
      panCard: '',
      selfie: '',
    };
    for (const item of uploads) {
      const ext = fileExt(item.file);
      if (!ext) return { ok: false, error: 'Use JPG, PNG, WEBP, or PDF documents.' };
      if (item.kind === 'selfie' && ext === 'pdf') {
        return { ok: false, error: 'Selfie must be a photo (JPG, PNG, or WEBP).' };
      }
      const key = `kyc/${uid}/${item.kind}.${ext}`;
      const contentType =
        ext === 'pdf'
          ? 'application/pdf'
          : ext === 'jpg'
            ? 'image/jpeg'
            : ext === 'png'
              ? 'image/png'
              : 'image/webp';
      const uploaded = await r2PutObject({ key, body: item.file.buffer, contentType });
      if (!uploaded.ok) return uploaded;
      paths[item.kind] = key;
    }

    const now = getCurrentIsoTime();
    const payload = {
      user_id: uid,
      aadhaar_number: dto.aadhaarNumber.trim(),
      pan: dto.pan.trim().toUpperCase(),
      bank_name: dto.bankName.trim(),
      account_holder: dto.accountHolder.trim(),
      account_number: dto.accountNumber.trim(),
      ifsc: dto.ifsc.trim().toUpperCase(),
      aadhaar_front_path: paths.aadhaarFront,
      aadhaar_back_path: paths.aadhaarBack,
      pan_card_path: paths.panCard,
      selfie_path: paths.selfie,
      submitted_at: now,
      reviewed_at: null,
    };
    const { error: kycError } = await this.supabase.from(TABLE_PARTNER_KYC).upsert(payload, {
      onConflict: 'user_id',
    });
    if (kycError) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.submitPartnerKyc', kycError);
      }
      return { ok: false, error: 'Could not save KYC. Run the partner_kyc SQL first.' };
    }

    const { error: statusError } = await this.users
      .update({ kyc_status: 'submitted', updated_at: now })
      .eq('id', uid);
    if (statusError) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('UsersService.submitPartnerKyc status', statusError);
      }
      return { ok: false, error: 'Documents saved but status could not be updated.' };
    }
    return { ok: true, kyc_status: 'submitted' };
  }
}
