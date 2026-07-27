import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Delete,
  UnauthorizedException,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../config/supabase';
import { adminInternalKeyOk } from '../common/admin-internal';
import { assertMobileAccess, extractIdToken } from '../common/phone-access';
import { TABLE_LEADS, MSG_OTP_PHONE_NOT_VERIFIED } from '../common/constants';
import { OtpModule, OtpService } from '../otp/otp.module';
import { UsersModule, UsersService } from '../users/users.module';
import {
  hashPan,
  isMaskedPan,
  isValidPanFormat,
  normalizePan,
  panStorageFields,
  redactSensitiveLeadPayload,
  toSafeLeadRow,
  decryptPan,
  maskPan,
  sanitizePublicLead,
} from '../security/pan-crypto';
import { PanAuditService } from '../security/pan-audit.service';
import { withDecryptedPanForPartner } from '../security/pan-partner';
import { allowRateLimitedAction } from '../security/rate-limit';
import {
  AdminCreateLeadDto,
  CompleteLeadDto,
  CreateLeadDto,
  RevealPanDto,
  StartLeadDto,
  UpdateLeadDto,
} from './leads.dto';

/** Placeholder until user completes the second-step form */
export const LEAD_DRAFT_FULL_NAME = 'Unknown';
export const LEAD_DRAFT_PAN = 'XXXXX0000X';

@Injectable()
export class LeadsService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly otpService: OtpService,
    private readonly panAudit: PanAuditService,
  ) {}

  private get leads() {
    return this.supabase.from(TABLE_LEADS);
  }

  private safeLead(row: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!row) return null;
    return toSafeLeadRow(row);
  }

  private safeLeads(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return rows.map((r) => toSafeLeadRow(r));
  }

  private async withOtpVerified(
    leads: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    if (!leads.length) return [];
    const mobiles = leads.map((l) => String(l.mobile_number ?? ''));
    const verifiedAtByMobile = await this.otpService.getVerifiedAtByMobiles(mobiles);
    // Allow 2 minutes skew so OTP completed just before lead insert still counts.
    const SKEW_MS = 2 * 60 * 1000;

    return leads.map((lead) => {
      const mobile = String(lead.mobile_number ?? '').trim();
      const createdRaw = String(lead.created_at ?? '').trim();
      const createdMs = createdRaw ? Date.parse(createdRaw) : NaN;
      const times = verifiedAtByMobile.get(mobile) ?? [];
      const otp_verified =
        times.length > 0 &&
        (!Number.isFinite(createdMs) ||
          times.some((at) => {
            const t = Date.parse(at);
            return Number.isFinite(t) && t >= createdMs - SKEW_MS;
          }));
      return { ...lead, otp_verified };
    });
  }

  isDraftLead(lead: Record<string, unknown>): boolean {
    const name = String(lead['full_name'] ?? '')
      .trim()
      .toLowerCase();
    const pan = String(lead['pan'] ?? '')
      .trim()
      .toUpperCase();
    return name === LEAD_DRAFT_FULL_NAME.toLowerCase() || pan === LEAD_DRAFT_PAN;
  }

  async getByMobile(mobileNumber: string): Promise<Record<string, unknown> | null> {
    const mobile = mobileNumber.trim();
    const { data, error } = await this.leads
      .select()
      .eq('mobile_number', mobile)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.getByMobile', error);
      }
      return null;
    }

    return (data as Record<string, unknown>) ?? null;
  }

  async getById(id: string): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.leads
      .select()
      .eq('id', id.trim())
      .eq('is_active', true)
      .maybeSingle();
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.getById', error);
      }
      return null;
    }
    return (data as Record<string, unknown>) ?? null;
  }

  /** All active leads for a mobile (newest first). Used by customer track status. */
  async listByMobile(
    mobileNumber: string,
    opts: { includeOtpVerified?: boolean } = {},
  ): Promise<Record<string, unknown>[]> {
    const mobile = mobileNumber.trim();
    const { data, error } = await this.leads
      .select()
      .eq('mobile_number', mobile)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.listByMobile', error);
      }
      return [];
    }

    const leads = (data as Record<string, unknown>[]) || [];
    if (opts.includeOtpVerified === false) {
      return this.safeLeads(leads);
    }
    const withOtp = await this.withOtpVerified(leads);
    return this.safeLeads(withOtp);
  }

  async getByPan(pan: string): Promise<Record<string, unknown> | null> {
    const panUpper = normalizePan(pan);
    if (!isValidPanFormat(panUpper)) return null;

    const digest = hashPan(panUpper);
    const byHash = await this.leads
      .select()
      .eq('pan_hash', digest)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!byHash.error && byHash.data) {
      return byHash.data as Record<string, unknown>;
    }

    // Legacy plaintext rows (pre-migration): lookup then stop returning plaintext via callers.
    const { data, error } = await this.leads
      .select()
      .eq('pan', panUpper)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.getByPan', error.message);
      }
      return null;
    }

    return (data as Record<string, unknown>) ?? null;
  }

  private normalizeCategory(category?: string | null): string {
    const c = String(category ?? '').trim();
    return c || 'personal_loan';
  }

  /** Active lead for this mobile + product category (newest first). */
  async getByMobileAndCategory(
    mobileNumber: string,
    category: string,
  ): Promise<Record<string, unknown> | null> {
    const mobile = mobileNumber.trim();
    const cat = this.normalizeCategory(category);
    const { data, error } = await this.leads
      .select()
      .eq('mobile_number', mobile)
      .eq('category', cat)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.getByMobileAndCategory', error);
      }
      return null;
    }

    return (data as Record<string, unknown>) ?? null;
  }

  /** Active lead for this PAN + product category (newest first). */
  async getByPanAndCategory(
    pan: string,
    category: string,
  ): Promise<Record<string, unknown> | null> {
    const panUpper = normalizePan(pan);
    if (!isValidPanFormat(panUpper)) return null;
    const cat = this.normalizeCategory(category);

    const digest = hashPan(panUpper);
    const byHash = await this.leads
      .select()
      .eq('pan_hash', digest)
      .eq('category', cat)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!byHash.error && byHash.data) {
      return byHash.data as Record<string, unknown>;
    }

    const { data, error } = await this.leads
      .select()
      .eq('pan', panUpper)
      .eq('category', cat)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.getByPanAndCategory', error.message);
      }
      return null;
    }

    return (data as Record<string, unknown>) ?? null;
  }

  /**
   * Create lead BEFORE OTP.
   * Same mobile/PAN may apply once per category (e.g. personal_loan + insurance).
   */
  async applyLead(dto: CreateLeadDto): Promise<{
    ok: boolean;
    lead?: Record<string, unknown>;
    message?: string;
  }> {
    const panUpper = normalizePan(dto.pan);
    if (!isValidPanFormat(panUpper)) {
      return { ok: false, message: 'Invalid PAN format.' };
    }

    const mobile = dto.mobileNumber.trim();
    const category = this.normalizeCategory(dto.category);
    const byMobile = await this.getByMobileAndCategory(mobile, category);
    if (byMobile && !this.isDraftLead(byMobile)) {
      return {
        ok: false,
        message:
          'You already have an application for this product with this mobile number.',
      };
    }

    const byPan = await this.getByPanAndCategory(panUpper, category);
    if (
      byPan &&
      !this.isDraftLead(byPan) &&
      String(byPan.id) !== String(byMobile?.id ?? '')
    ) {
      return {
        ok: false,
        message: 'You already have an application for this product with this PAN.',
      };
    }

    let panFields: ReturnType<typeof panStorageFields>;
    try {
      panFields = panStorageFields(panUpper);
    } catch {
      return { ok: false, message: 'Invalid PAN format.' };
    }

    const payload: Record<string, unknown> = {
      ...panFields,
      mobile_number: mobile,
      full_name: dto.fullName.trim(),
      email: dto.email?.trim() || null,
      pincode: dto.pincode?.trim() || null,
      required_amount: dto.requiredAmount || null,
      category,
      status: 'pending',
      is_active: true,
    };

    if (dto.userId?.trim()) payload.user_id = dto.userId.trim();
    if (category === 'personal_loan') {
      payload.loan_amt = null;
      if (dto.requiredAmount != null) payload.required_amount = dto.requiredAmount;
      if (dto.employmentType) payload.employment_type = dto.employmentType;
      if (dto.netMonthlyIncome != null) payload.net_monthly_income = dto.netMonthlyIncome;
    }
    if (category === 'insurance') {
      payload.required_amount = null;
      payload.loan_amt = null;
      if (dto.insType) payload.ins_type = dto.insType;
    }

    // Upgrade OTP/start draft for this category only — never overwrite another product.
    if (byMobile && this.isDraftLead(byMobile) && byMobile.id) {
      const updated = await this.updateById(String(byMobile.id), {
        pan: panUpper,
        fullName: dto.fullName.trim(),
        email: dto.email,
        pincode: dto.pincode,
        requiredAmount: category === 'insurance' ? null : dto.requiredAmount,
        category,
        status: 'pending',
        loanAmt: category === 'personal_loan' ? null : undefined,
        insType: category === 'insurance' ? dto.insType ?? null : null,
        employmentType:
          category === 'personal_loan' ? dto.employmentType ?? null : null,
        netMonthlyIncome:
          category === 'personal_loan' ? dto.netMonthlyIncome ?? null : null,
      });
      if (!updated) {
        return { ok: false, message: 'Failed to create lead. Please try again.' };
      }
      await this.panAudit.record({
        leadId: String(byMobile.id),
        action: 'update',
        reason: 'public_apply_upgrade_draft',
        metadata: { pan_masked: panFields.pan },
      });
      return { ok: true, lead: updated };
    }

    const { data, error } = await this.leads.insert(payload).select().single();
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.applyLead', error.message, redactSensitiveLeadPayload(payload));
      }
      return { ok: false, message: 'Failed to create lead. Please try again.' };
    }

    const lead = data as Record<string, unknown>;
    if (lead.id) {
      await this.panAudit.record({
        leadId: String(lead.id),
        action: 'create',
        reason: 'public_apply',
        metadata: { pan_masked: panFields.pan },
      });
    }

    return { ok: true, lead: this.safeLead(lead)! };
  }

  async createDraft(mobileNumber: string, category: string): Promise<Record<string, unknown> | null> {
    const payload: Record<string, unknown> = {
      pan: LEAD_DRAFT_PAN,
      pan_encrypted: null,
      pan_hash: null,
      mobile_number: mobileNumber.trim(),
      full_name: LEAD_DRAFT_FULL_NAME,
      email: null,
      pincode: null,
      required_amount: null,
      category: category || 'personal_loan',
      status: 'pending',
      is_active: true,
    };

    const { data, error } = await this.leads.insert(payload).select().single();

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.createDraft error:', error.message, redactSensitiveLeadPayload(payload));
      }
      return null;
    }

    return this.safeLead(data as Record<string, unknown>);
  }

  async startLead(mobileNumber: string, category?: string): Promise<{
    ok: boolean;
    lead?: Record<string, unknown>;
    isDraft?: boolean;
    message?: string;
  }> {
    const cat = this.normalizeCategory(category);
    const existing = await this.getByMobileAndCategory(mobileNumber, cat);

    if (existing) {
      // Chat OTP → start: only block when this product already has a real application.
      if (!this.isDraftLead(existing)) {
        return {
          ok: false,
          message:
            'You already have an application for this product with this mobile number.',
        };
      }
      return {
        ok: true,
        lead: this.safeLead(existing)!,
        isDraft: true,
      };
    }

    const created = await this.createDraft(mobileNumber, cat);
    if (!created) return { ok: false, message: 'Failed to save mobile number.' };
    return { ok: true, lead: created, isDraft: true };
  }

  async completeLead(
    id: string,
    dto: CompleteLeadDto,
  ): Promise<{ ok: true; lead: Record<string, unknown> } | { ok: false; message: string }> {
    const panUpper = normalizePan(dto.pan);
    if (!isValidPanFormat(panUpper)) {
      return { ok: false, message: 'Invalid PAN format.' };
    }

    const existing = await this.leads
      .select()
      .eq('id', id)
      .eq('is_active', true)
      .maybeSingle();
    if (existing.error || !existing.data) {
      return { ok: false, message: 'Application not found.' };
    }

    const row = existing.data as Record<string, unknown>;
    const mobile = String(row['mobile_number'] ?? '').trim();
    const category = this.normalizeCategory(
      dto.category?.trim() || String(row['category'] ?? ''),
    );
    const other = await this.getByMobileAndCategory(mobile, category);
    if (
      other &&
      String(other['id']) !== id &&
      !this.isDraftLead(other)
    ) {
      return {
        ok: false,
        message:
          'You already have an application for this product with this mobile number.',
      };
    }

    const duplicatePan = await this.getByPanAndCategory(panUpper, category);
    if (
      duplicatePan &&
      String(duplicatePan.id) !== id &&
      !this.isDraftLead(duplicatePan)
    ) {
      return {
        ok: false,
        message: 'You already have an application for this product with this PAN.',
      };
    }

    const update: UpdateLeadDto = {
      pan: panUpper,
      fullName: dto.fullName.trim(),
      category: dto.category ?? category,
      status: 'pending',
    };

    if (category === 'personal_loan') {
      update.loanAmt = dto.loanAmt ?? null;
      update.insType = null;
      if (dto.requiredAmount != null) update.requiredAmount = dto.requiredAmount;
      if (dto.employmentType) update.employmentType = dto.employmentType;
      if (dto.netMonthlyIncome != null) update.netMonthlyIncome = dto.netMonthlyIncome;
    } else if (category === 'insurance') {
      update.insType = dto.insType ?? null;
      update.loanAmt = null;
      update.requiredAmount = null;
      update.employmentType = null;
      update.netMonthlyIncome = null;
    }

    const lead = await this.updateById(id, update);
    if (!lead) {
      return {
        ok: false,
        message: 'Failed to update details. Please check PAN and try again.',
      };
    }
    return { ok: true, lead };
  }

  async create(dto: CreateLeadDto): Promise<Record<string, unknown> | null> {
    const panUpper = normalizePan(dto.pan);
    if (!isValidPanFormat(panUpper)) {
      return null;
    }

    let panFields: ReturnType<typeof panStorageFields>;
    try {
      panFields = panStorageFields(panUpper);
    } catch {
      return null;
    }

    const payload: Record<string, unknown> = {
      ...panFields,
      mobile_number: dto.mobileNumber.trim(),
      full_name: dto.fullName.trim(),
      email: dto.email?.trim() || null,
      pincode: dto.pincode?.trim() || null,
      required_amount: dto.requiredAmount || null,
      category: dto.category || 'personal_loan',
      status: 'pending',
      is_active: true,
    };

    if (dto.userId && dto.userId.trim()) {
      payload.user_id = dto.userId.trim();
    }

    if (dto.category === 'personal_loan') {
      payload.loan_amt = null;
      if (dto.requiredAmount != null) payload.required_amount = dto.requiredAmount;
      if (dto.employmentType) payload.employment_type = dto.employmentType;
      if (dto.netMonthlyIncome != null) payload.net_monthly_income = dto.netMonthlyIncome;
    }
    if (dto.category === 'insurance' && dto.insType) {
      payload.ins_type = dto.insType;
    }

    const { data, error } = await this.leads.insert(payload).select().single();

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.create error:', error.message, redactSensitiveLeadPayload(payload));
      }
      return null;
    }

    const lead = data as Record<string, unknown>;
    if (lead.id) {
      await this.panAudit.record({
        leadId: String(lead.id),
        action: 'create',
        reason: 'admin_or_api_create',
        metadata: { pan_masked: panFields.pan },
      });
    }

    return this.safeLead(lead);
  }

  async getByUserId(userId: string): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.leads
      .select()
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.getByUserId', error);
      }
      return [];
    }

    return this.safeLeads((data as Record<string, unknown>[]) || []);
  }

  async getByCategory(userId: string, category: string): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.leads
      .select()
      .eq('user_id', userId)
      .eq('category', category)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.getByCategory', error.message);
      }
      return [];
    }

    return this.safeLeads((data as Record<string, unknown>[]) || []);
  }

  async getAll(): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.leads
      .select()
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.getAll', error.message);
      }
      return [];
    }

    const leads = (data as Record<string, unknown>[]) || [];
    const withOtp = await this.withOtpVerified(leads);
    return this.safeLeads(withOtp);
  }

  async updateById(id: string, dto: UpdateLeadDto): Promise<Record<string, unknown> | null> {
    const existing = await this.getById(id);
    if (!existing) return null;

    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (dto.fullName != null) payload.full_name = dto.fullName.trim();
    if (dto.email !== undefined) payload.email = dto.email?.trim() || null;
    if (dto.mobileNumber != null) {
      const mobile = dto.mobileNumber.trim();
      const category = this.normalizeCategory(
        dto.category ?? String(existing['category'] ?? ''),
      );
      const otherMobile = await this.getByMobileAndCategory(mobile, category);
      if (otherMobile && String(otherMobile.id) !== id && !this.isDraftLead(otherMobile)) {
        return null;
      }
      payload.mobile_number = mobile;
    }
    if (dto.pincode !== undefined) payload.pincode = dto.pincode?.trim() || null;
    if (dto.requiredAmount !== undefined) payload.required_amount = dto.requiredAmount ?? null;
    if (dto.category != null) payload.category = dto.category;
    if (dto.status != null) payload.status = dto.status;
    if (dto.notes !== undefined) payload.notes = dto.notes?.trim() || null;
    if (dto.loanAmt !== undefined) payload.loan_amt = dto.loanAmt ?? null;
    if (dto.insType !== undefined) payload.ins_type = dto.insType ?? null;
    if (dto.employmentType !== undefined) {
      payload.employment_type = dto.employmentType ?? null;
    }
    if (dto.netMonthlyIncome !== undefined) {
      payload.net_monthly_income = dto.netMonthlyIncome ?? null;
    }

    let panChanged = false;
    let panMasked: string | null = null;
    if (dto.pan != null && String(dto.pan).trim() !== '') {
      // Masked value means "leave PAN unchanged" (admin edit form).
      if (isMaskedPan(String(dto.pan))) {
        // skip
      } else {
        const panUpper = normalizePan(dto.pan);
        if (!isValidPanFormat(panUpper)) return null;
        const category = this.normalizeCategory(
          dto.category ??
            (payload.category as string | undefined) ??
            String(existing['category'] ?? ''),
        );
        const other = await this.getByPanAndCategory(panUpper, category);
        if (other && String(other.id) !== id && !this.isDraftLead(other)) return null;
        try {
          const fields = panStorageFields(panUpper);
          Object.assign(payload, fields);
          panChanged = true;
          panMasked = fields.pan;
        } catch {
          return null;
        }
      }
    }

    if (Object.keys(payload).length === 1) return null;

    const { data, error } = await this.leads
      .update(payload)
      .eq('id', id)
      .eq('is_active', true)
      .select()
      .single();

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.updateById', error.message, redactSensitiveLeadPayload(payload));
      }
      return null;
    }

    const lead = data as Record<string, unknown>;
    if (panChanged && lead.id) {
      await this.panAudit.record({
        leadId: String(lead.id),
        action: 'update',
        reason: 'pan_rotated',
        metadata: { pan_masked: panMasked },
      });
    }

    return this.safeLead(lead);
  }

  /**
   * Decrypt PAN for authorized admin reveal. Always audited.
   * Never logs the plaintext value.
   */
  async revealPan(
    id: string,
    actor: {
      adminId?: string;
      adminEmail?: string;
      adminRole?: string;
      ipAddress?: string;
      userAgent?: string;
      reason?: string;
    },
  ): Promise<{ ok: true; pan: string; masked: string } | { ok: false; message: string }> {
    const row = await this.getById(id);
    if (!row) return { ok: false, message: 'Lead not found' };
    if (this.isDraftLead(row)) {
      return { ok: false, message: 'PAN not available for incomplete applications' };
    }

    const encrypted = row.pan_encrypted != null ? String(row.pan_encrypted) : '';
    let plain: string | null = null;

    if (encrypted) {
      try {
        plain = decryptPan(encrypted);
      } catch {
        await this.panAudit.record({
          leadId: id,
          action: 'decrypt_failed',
          adminId: actor.adminId,
          adminEmail: actor.adminEmail,
          adminRole: actor.adminRole,
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent,
          reason: actor.reason ?? 'admin_reveal',
        });
        return { ok: false, message: 'Unable to decrypt PAN' };
      }
    } else {
      // Legacy plaintext migration path — encrypt in place after reveal.
      const legacy = normalizePan(String(row.pan ?? ''));
      if (!isValidPanFormat(legacy) || legacy === LEAD_DRAFT_PAN) {
        return { ok: false, message: 'PAN not available' };
      }
      plain = legacy;
      try {
        const fields = panStorageFields(legacy);
        await this.leads.update(fields).eq('id', id).eq('is_active', true);
      } catch {
        // still allow reveal of legacy value
      }
    }

    const audited = await this.panAudit.record({
      leadId: id,
      action: 'reveal',
      adminId: actor.adminId,
      adminEmail: actor.adminEmail,
      adminRole: actor.adminRole,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      reason: actor.reason ?? 'admin_reveal',
      metadata: { pan_masked: maskPan(plain) },
    });
    if (!audited) {
      return { ok: false, message: 'Audit logging failed; PAN not revealed' };
    }

    return { ok: true, pan: plain, masked: maskPan(plain) };
  }

  /**
   * Decrypt temporarily and invoke partner handler. Audited as partner_send.
   */
  async sendPanToPartner(
    leadId: string,
    partner: { id: string; name?: string },
    actor: {
      adminId?: string;
      adminEmail?: string;
      adminRole?: string;
      ipAddress?: string;
      userAgent?: string;
      reason?: string;
    },
    handler: (plainPan: string) => Promise<void> | void,
  ) {
    const row = await this.getById(leadId);
    if (!row?.pan_encrypted) {
      return { ok: false as const, message: 'Encrypted PAN not found for this lead' };
    }
    return withDecryptedPanForPartner(
      String(row.pan_encrypted),
      this.panAudit,
      {
        leadId,
        partnerId: partner.id,
        partnerName: partner.name,
        adminId: actor.adminId,
        adminEmail: actor.adminEmail,
        adminRole: actor.adminRole,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        reason: actor.reason,
      },
      handler,
    );
  }

  /** Update shared applicant details on every active lead for a mobile. */
  async updateProfileByMobile(
    mobileNumber: string,
    dto: { fullName?: string; email?: string | null },
  ): Promise<boolean> {
    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (dto.fullName != null) payload.full_name = dto.fullName.trim();
    if (dto.email !== undefined) payload.email = dto.email?.trim() || null;
    if (Object.keys(payload).length === 1) return false;

    const { error } = await this.leads
      .update(payload)
      .eq('mobile_number', mobileNumber.trim())
      .eq('is_active', true);

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.updateProfileByMobile', error.message);
      }
      return false;
    }

    return true;
  }

  async deleteById(id: string): Promise<boolean> {
    const { data, error } = await this.leads
      .delete()
      .eq('id', id.trim())
      .select('id');

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.deleteById', error.message);
      }
      return false;
    }

    return Array.isArray(data) && data.length > 0;
  }
}

@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leadsService: LeadsService,
    private readonly otpService: OtpService,
    private readonly usersService: UsersService,
  ) {}

  private sanitizePublicLead(lead: Record<string, unknown>): Record<string, unknown> {
    return sanitizePublicLead(lead);
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  async getAll() {
    return {
      success: true,
      message: 'Leads API is working! Prefer POST /api/leads/apply for new applications.',
      endpoints: {
        apply: 'POST /api/leads/apply',
        start: 'POST /api/leads/start',
        getByUser: 'GET /api/leads/user/:userId (auth required)',
      },
    };
  }

  @Post('start')
  @HttpCode(HttpStatus.OK)
  async start(@Body() dto: StartLeadDto) {
    const verified = await this.otpService.hasRecentPhoneVerification(
      dto.mobileNumber,
    );
    if (!verified) {
      return {
        success: false,
        message: MSG_OTP_PHONE_NOT_VERIFIED,
      };
    }

    const result = await this.leadsService.startLead(
      dto.mobileNumber,
      dto.category,
    );

    if (!result.ok || !result.lead) {
      return {
        success: false,
        message: result.message || 'Failed to save mobile number. Please try again.',
      };
    }

    return {
      success: true,
      data: this.sanitizePublicLead(result.lead),
      isDraft: result.isDraft === true,
    };
  }

  /**
   * Public apply: save lead BEFORE OTP.
   * Same mobile/PAN allowed once per product category.
   */
  @Post('apply')
  @HttpCode(HttpStatus.CREATED)
  async apply(@Body() dto: CreateLeadDto) {
    const result = await this.leadsService.applyLead(dto);
    if (!result.ok || !result.lead) {
      const message = result.message || 'Failed to create lead';
      if (
        message.toLowerCase().includes('already') ||
        message.toLowerCase().includes('already have')
      ) {
        throw new ConflictException(message);
      }
      throw new BadRequestException(message);
    }
    return { success: true, data: this.sanitizePublicLead(result.lead) };
  }

  @Patch(':id/complete')
  @HttpCode(HttpStatus.OK)
  async complete(
    @Param('id') id: string,
    @Body() dto: CompleteLeadDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Headers('x-admin-internal-key') adminKey: string | undefined,
  ) {
    const existing = await this.leadsService.getById(id);
    if (!existing) {
      return { success: false, message: 'Lead not found.' };
    }
    const mobile = String(existing.mobile_number ?? '').trim();
    await assertMobileAccess(this.otpService, mobile, {
      adminKey,
      idToken: extractIdToken(headers),
    });

    const result = await this.leadsService.completeLead(id, dto);
    if (!result.ok) {
      const message = result.message || 'Failed to update details.';
      if (
        message.toLowerCase().includes('already') ||
        message.toLowerCase().includes('already have')
      ) {
        throw new ConflictException(message);
      }
      throw new BadRequestException(message);
    }
    return { success: true, data: this.sanitizePublicLead(result.lead) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateLeadDto,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Headers('x-admin-internal-key') adminKey: string | undefined,
  ) {
    await assertMobileAccess(this.otpService, dto.mobileNumber, {
      adminKey,
      idToken: extractIdToken(headers),
    });

    try {
      const existing = await this.leadsService.getByMobileAndCategory(
        dto.mobileNumber,
        dto.category || 'personal_loan',
      );
      if (existing) {
        const updated = await this.leadsService.updateById(String(existing['id']), {
          pan: dto.pan,
          fullName: dto.fullName,
          category: dto.category,
          email: dto.email,
          pincode: dto.pincode,
          requiredAmount: dto.requiredAmount,
          loanAmt: dto.category === 'personal_loan' ? dto.loanAmt ?? null : null,
          insType: dto.category === 'insurance' ? dto.insType ?? null : null,
          employmentType:
            dto.category === 'personal_loan' ? dto.employmentType ?? null : null,
          netMonthlyIncome:
            dto.category === 'personal_loan' ? dto.netMonthlyIncome ?? null : null,
        });
        if (!updated) {
          return { success: false, message: 'Failed to update lead' };
        }
        return { success: true, data: this.sanitizePublicLead(updated) };
      }

      const lead = await this.leadsService.create(dto);
      if (!lead) {
        return { success: false, message: 'Failed to create lead' };
      }
      return { success: true, data: this.sanitizePublicLead(lead) };
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsController.create', error);
      }
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to create lead',
      };
    }
  }

  @Get('user/:userId')
  @HttpCode(HttpStatus.OK)
  async getByUserId(
    @Param('userId') userId: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Headers('x-admin-internal-key') adminKey: string | undefined,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      const user = await this.usersService.getById(userId);
      const mobile = String(user?.mobile_number ?? '').trim();
      if (!mobile) throw new UnauthorizedException('Unauthorized');
      await assertMobileAccess(this.otpService, mobile, {
        adminKey,
        idToken: extractIdToken(headers),
      });
    }
    const leads = await this.leadsService.getByUserId(userId);
    return { success: true, data: leads.map((l) => this.sanitizePublicLead(l)) };
  }

  @Get('user/:userId/category/:category')
  @HttpCode(HttpStatus.OK)
  async getByCategory(
    @Param('userId') userId: string,
    @Param('category') category: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Headers('x-admin-internal-key') adminKey: string | undefined,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      const user = await this.usersService.getById(userId);
      const mobile = String(user?.mobile_number ?? '').trim();
      if (!mobile) throw new UnauthorizedException('Unauthorized');
      await assertMobileAccess(this.otpService, mobile, {
        adminKey,
        idToken: extractIdToken(headers),
      });
    }
    const leads = await this.leadsService.getByCategory(userId, category);
    return { success: true, data: leads.map((l) => this.sanitizePublicLead(l)) };
  }

  @Get('admin/all')
  @HttpCode(HttpStatus.OK)
  async getAllForAdmin(@Headers('x-admin-internal-key') adminKey: string | undefined) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const leads = await this.leadsService.getAll();
    return { success: true, data: leads };
  }

  /** Always insert a new lead (admin CRM). Does not upsert by mobile. */
  @Post('admin')
  @HttpCode(HttpStatus.CREATED)
  async createForAdmin(
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Body() dto: AdminCreateLeadDto,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }

    const category = dto.category || 'personal_loan';
    const [byMobile, byPan] = await Promise.all([
      this.leadsService.getByMobileAndCategory(dto.mobileNumber, category),
      this.leadsService.getByPanAndCategory(dto.pan, category),
    ]);
    if (byMobile && !this.leadsService.isDraftLead(byMobile)) {
      return {
        success: false,
        field: 'mobileNumber',
        message: 'A lead with this phone number already exists for this product',
      };
    }
    if (
      byPan &&
      !this.leadsService.isDraftLead(byPan) &&
      String(byPan.id) !== String(byMobile?.id ?? '')
    ) {
      return {
        success: false,
        field: 'pan',
        message: 'A lead with this PAN already exists for this product',
      };
    }

    const created = await this.leadsService.create({
      pan: dto.pan,
      mobileNumber: dto.mobileNumber,
      fullName: dto.fullName,
      email: dto.email,
      pincode: dto.pincode,
      requiredAmount: dto.requiredAmount,
      category: dto.category,
      loanAmt: dto.loanAmt,
      insType: dto.insType,
      employmentType: dto.employmentType,
      netMonthlyIncome: dto.netMonthlyIncome,
    });

    if (!created?.id) {
      return {
        success: false,
        message: 'Failed to create lead. Check PAN / mobile and try again.',
      };
    }

    let lead = created;
    if (dto.status != null || dto.notes !== undefined) {
      const updated = await this.leadsService.updateById(String(created.id), {
        status: dto.status,
        notes: dto.notes,
      });
      if (updated) lead = updated;
    }

    return { success: true, data: lead };
  }

  @Patch('admin/:id')
  @HttpCode(HttpStatus.OK)
  async updateForAdmin(
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Param('id') id: string,
    @Body() dto: UpdateLeadDto,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const lead = await this.leadsService.updateById(id, dto);
    if (!lead) {
      throw new NotFoundException('Lead not found or update failed');
    }
    return { success: true, data: lead };
  }

  /**
   * Reveal full PAN for a lead. Requires admin internal key.
   * Every call is written to pan_access_audit with admin identity + timestamp.
   */
  @Post('admin/:id/pan/reveal')
  @HttpCode(HttpStatus.OK)
  async revealPanForAdmin(
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Param('id') id: string,
    @Body() dto: RevealPanDto,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    if (!dto.adminEmail?.trim() && !dto.adminId?.trim()) {
      throw new BadRequestException('Admin identity is required for PAN reveal');
    }
    const role = String(dto.adminRole ?? '').trim().toLowerCase();
    if (role !== 'admin' && role !== 'staff') {
      throw new UnauthorizedException('Insufficient role for PAN reveal');
    }

    const rateKey = `pan-reveal:${dto.adminEmail || dto.adminId}`;
    if (!allowRateLimitedAction(rateKey, 10, 60_000)) {
      throw new BadRequestException('Too many PAN reveals. Try again in a minute.');
    }

    const result = await this.leadsService.revealPan(id, {
      adminId: dto.adminId,
      adminEmail: dto.adminEmail,
      adminRole: dto.adminRole,
      ipAddress: dto.ipAddress,
      userAgent: dto.userAgent,
      reason: dto.reason ?? 'admin_panel_reveal',
    });

    if (!result.ok) {
      throw new NotFoundException(result.message);
    }

    return {
      success: true,
      pan: result.pan,
      masked: result.masked,
      revealedAt: new Date().toISOString(),
    };
  }

  @Delete('admin/:id')
  @HttpCode(HttpStatus.OK)
  async deleteForAdmin(
    @Headers('x-admin-internal-key') adminKey: string | undefined,
    @Param('id') id: string,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const ok = await this.leadsService.deleteById(id);
    if (!ok) {
      throw new NotFoundException('Lead not found or delete failed');
    }
    return { success: true };
  }
}

@Module({
  imports: [OtpModule, UsersModule],
  controllers: [LeadsController],
  providers: [LeadsService, PanAuditService],
  exports: [LeadsService, PanAuditService],
})
export class LeadsModule {}
