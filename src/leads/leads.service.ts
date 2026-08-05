import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../config/supabase';
import { TABLE_LEADS } from '../common/constants';
import { resolveIpLocation } from '../common/ip-geo';
import { OtpService } from '../otp/otp.service';
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
} from '../security/pan-crypto';
import { PanAuditService } from '../security/pan-audit.service';
import { withDecryptedPanForPartner } from '../security/pan-partner';
import { allowRateLimitedAction } from '../security/rate-limit';
import {
  CompleteLeadDto,
  CreateLeadDto,
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

  /** Attach client IP + best-effort geo label for admin display. */
  private async ipFields(
    clientIp?: string | null,
  ): Promise<{ ip?: string; ip_location?: string | null }> {
    const ip = String(clientIp ?? '').trim().slice(0, 45);
    if (!ip) return {};
    const location = await resolveIpLocation(ip);
    // Only send ip_location when known — avoids insert errors if column not migrated yet.
    return location ? { ip, ip_location: location } : { ip };
  }

  private missingColumnFromError(message: string | undefined): string | null {
    if (!message) return null;
    // PostgREST: Could not find the 'ip_location' column of 'leads' in the schema cache
    const m = message.match(/'([^']+)' column/i) ?? message.match(/column "?([a-z_][a-z0-9_]*)"?/i);
    return m?.[1] ?? null;
  }

  /** Insert with automatic drop of payload keys DB schema does not have yet. */
  private async insertLead(
    payload: Record<string, unknown>,
    logLabel: string,
  ): Promise<{ data: Record<string, unknown> | null; errorMessage?: string }> {
    let body = { ...payload };
    for (let attempt = 0; attempt < 6; attempt++) {
      const { data, error } = await this.leads.insert(body).select().single();
      if (!error) {
        return { data: (data as Record<string, unknown>) ?? null };
      }
      const col = this.missingColumnFromError(error.message);
      if (col && Object.prototype.hasOwnProperty.call(body, col)) {
        console.error(`${logLabel}: missing column "${col}", retrying without it`);
        const next = { ...body };
        delete next[col];
        body = next;
        continue;
      }
      console.error(logLabel, error.message, redactSensitiveLeadPayload(body));
      return { data: null, errorMessage: error.message };
    }
    return { data: null, errorMessage: 'Insert failed after schema retries' };
  }

  private async updateLeadRow(
    id: string,
    payload: Record<string, unknown>,
    logLabel: string,
  ): Promise<{ data: Record<string, unknown> | null; errorMessage?: string }> {
    let body = { ...payload };
    for (let attempt = 0; attempt < 6; attempt++) {
      const { data, error } = await this.leads
        .update(body)
        .eq('id', id)
        .eq('is_active', true)
        .select()
        .single();
      if (!error) {
        return { data: (data as Record<string, unknown>) ?? null };
      }
      const col = this.missingColumnFromError(error.message);
      if (col && Object.prototype.hasOwnProperty.call(body, col)) {
        console.error(`${logLabel}: missing column "${col}", retrying without it`);
        const next = { ...body };
        delete next[col];
        body = next;
        continue;
      }
      console.error(logLabel, error.message, redactSensitiveLeadPayload(body));
      return { data: null, errorMessage: error.message };
    }
    return { data: null, errorMessage: 'Update failed after schema retries' };
  }

  /** Defense in depth if ValidationPipe is bypassed. */
  private personalLoanEmploymentError(dto: {
    employmentType?: string | null;
    netMonthlyIncome?: number | null;
  }): string | null {
    const emp = String(dto.employmentType ?? '').trim();
    if (emp !== 'salaried' && emp !== 'self_employed') {
      return 'Employment type is required for personal loan.';
    }
    const income = dto.netMonthlyIncome;
    if (income == null || !Number.isFinite(Number(income)) || Number(income) < 1) {
      return 'Net monthly income is required for personal loan.';
    }
    return null;
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
  async applyLead(dto: CreateLeadDto, meta?: { clientIp?: string | null }): Promise<{
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
    if (category === 'personal_loan') {
      const empErr = this.personalLoanEmploymentError(dto);
      if (empErr) return { ok: false, message: empErr };
    }
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
    Object.assign(payload, await this.ipFields(meta?.clientIp));
    if (category === 'personal_loan') {
      payload.loan_amt = null;
      if (dto.requiredAmount != null) payload.required_amount = dto.requiredAmount;
      payload.employment_type = dto.employmentType;
      payload.net_monthly_income = dto.netMonthlyIncome;
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
        clientIp: meta?.clientIp ?? undefined,
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

    const { data, errorMessage } = await this.insertLead(payload, 'LeadsService.applyLead');
    if (!data) {
      // Prefer useful DB signal in non-prod; production stays generic for applicants.
      const detail =
        process.env.NODE_ENV !== 'production' && errorMessage
          ? ` (${errorMessage})`
          : '';
      return {
        ok: false,
        message: `Failed to create lead. Please try again.${detail}`,
      };
    }

    const lead = data;
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

  async createDraft(mobileNumber: string, category: string, clientIp?: string | null): Promise<Record<string, unknown> | null> {
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
    if (clientIp) Object.assign(payload, await this.ipFields(clientIp));

    const { data, errorMessage } = await this.insertLead(payload, 'LeadsService.createDraft');
    if (!data) {
      if (process.env.NODE_ENV !== 'production' && errorMessage) {
        console.error('LeadsService.createDraft failed:', errorMessage);
      }
      return null;
    }

    return this.safeLead(data);
  }

  async startLead(mobileNumber: string, category?: string, clientIp?: string | null): Promise<{
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

    const created = await this.createDraft(mobileNumber, cat, clientIp);
    if (!created) return { ok: false, message: 'Failed to save mobile number.' };
    return { ok: true, lead: created, isDraft: true };
  }

  async completeLead(
    id: string,
    dto: CompleteLeadDto,
    meta?: { clientIp?: string | null },
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
    if (category === 'personal_loan') {
      const empErr = this.personalLoanEmploymentError(dto);
      if (empErr) return { ok: false, message: empErr };
    }
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

    if (dto.pincode?.trim()) {
      update.pincode = dto.pincode.trim();
    }
    if (meta?.clientIp) {
      update.clientIp = meta.clientIp;
    }

    if (category === 'personal_loan') {
      update.loanAmt = dto.loanAmt ?? null;
      update.insType = null;
      if (dto.requiredAmount != null) update.requiredAmount = dto.requiredAmount;
      update.employmentType = dto.employmentType;
      update.netMonthlyIncome = dto.netMonthlyIncome;
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

  async create(dto: CreateLeadDto, meta?: { clientIp?: string | null }): Promise<Record<string, unknown> | null> {
    const panUpper = normalizePan(dto.pan);
    if (!isValidPanFormat(panUpper)) {
      return null;
    }

    const category = this.normalizeCategory(dto.category || 'personal_loan');
    if (category === 'personal_loan') {
      if (this.personalLoanEmploymentError(dto)) return null;
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
      required_amount: category === 'insurance' ? null : dto.requiredAmount || null,
      category,
      status: 'pending',
      is_active: true,
    };

    if (dto.userId && dto.userId.trim()) {
      payload.user_id = dto.userId.trim();
    }
    Object.assign(payload, await this.ipFields(meta?.clientIp));

    if (category === 'personal_loan') {
      payload.loan_amt = null;
      if (dto.requiredAmount != null) payload.required_amount = dto.requiredAmount;
      payload.employment_type = dto.employmentType;
      payload.net_monthly_income = dto.netMonthlyIncome;
    }
    if (category === 'insurance' && dto.insType) {
      payload.ins_type = dto.insType;
    }

    const { data, errorMessage } = await this.insertLead(payload, 'LeadsService.create');
    if (!data) {
      if (process.env.NODE_ENV !== 'production' && errorMessage) {
        console.error('LeadsService.create failed:', errorMessage);
      }
      return null;
    }

    if (data.id) {
      await this.panAudit.record({
        leadId: String(data.id),
        action: 'create',
        reason: 'admin_or_api_create',
        metadata: { pan_masked: panFields.pan },
      });
    }

    return this.safeLead(data);
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
    const safe = this.safeLeads(withOtp);
    return this.enrichMissingIpLocations(safe);
  }

  /**
   * Resolve geo for rows that have IP but no stored location (legacy rows).
   * Caps unique lookups so the admin list stays responsive.
   */
  private async enrichMissingIpLocations(
    rows: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    const need = new Map<string, string[]>();
    for (const row of rows) {
      const ip = String(row.ip ?? '').trim();
      const loc = String(row.ip_location ?? '').trim();
      if (!ip || loc) continue;
      const ids = need.get(ip) ?? [];
      if (row.id != null) ids.push(String(row.id));
      need.set(ip, ids);
    }
    if (need.size === 0) return rows;

    const ips = [...need.keys()].slice(0, 40);
    const resolved = await Promise.all(
      ips.map(async (ip) => [ip, await resolveIpLocation(ip)] as const),
    );

    const byIp = new Map(resolved);
    const updates: Array<{ id: string; location: string }> = [];

    const out = rows.map((row) => {
      const ip = String(row.ip ?? '').trim();
      if (!ip || String(row.ip_location ?? '').trim()) return row;
      const location = byIp.get(ip);
      if (!location) return row;
      if (row.id != null) updates.push({ id: String(row.id), location });
      return { ...row, ip_location: location };
    });

    // Persist best-effort so next load is free of geo API calls
    void Promise.all(
      updates.slice(0, 40).map(({ id, location }) =>
        this.leads.update({ ip_location: location }).eq('id', id).then(() => undefined),
      ),
    ).catch(() => undefined);

    return out;
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
    if (dto.clientIp !== undefined) {
      const trimmed = dto.clientIp?.trim() || null;
      if (!trimmed) {
        payload.ip = null;
        payload.ip_location = null;
      } else {
        Object.assign(payload, await this.ipFields(trimmed));
      }
    }
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

    const { data, errorMessage } = await this.updateLeadRow(
      id,
      payload,
      'LeadsService.updateById',
    );
    if (!data) {
      if (process.env.NODE_ENV !== 'production' && errorMessage) {
        console.error('LeadsService.updateById failed:', errorMessage);
      }
      return null;
    }

    if (panChanged && data.id) {
      await this.panAudit.record({
        leadId: String(data.id),
        action: 'update',
        reason: 'pan_rotated',
        metadata: { pan_masked: panMasked },
      });
    }

    return this.safeLead(data);
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
