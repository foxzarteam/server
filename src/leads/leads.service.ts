import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../config/supabase';
import {
  TABLE_LEAD_MOBILE_PAN_SLOTS,
  TABLE_LEADS,
  TABLE_PAN_ACCESS_AUDIT,
} from '../common/constants';
import { resolveIpLocation, resolveIpLocationsBatch } from '../common/ip-geo';
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
import { UsersService } from '../users/users.service';
import { WalletService } from '../wallet/wallet.service';
import { ServicesService } from '../services/services.service';
import {
  CODE_LOAN_AMOUNT_REQUIRED,
  leadLoanAmount,
  MSG_LOAN_AMOUNT_REQUIRED,
  personalLoanAmountError,
  resolvePersonalLoanAmounts,
} from '../wallet/loan-amount';
import {
  CODE_APPROVE_ADMIN_ONLY,
  isCommissionAffectingChange,
  MSG_APPROVE_ADMIN_ONLY,
  MSG_WALLET_SYNC_FAILED,
  MSG_WALLET_SYNC_FAILED_STATUS_SAVED,
  requiresAdminCommissionGate,
  WalletSyncError,
} from '../wallet/wallet-sync';
import { withDecryptedPanForPartner } from '../security/pan-partner';
import { allowRateLimitedAction } from '../security/rate-limit';
import {
  CompleteLeadDto,
  CreateLeadDto,
  UpdateLeadDto,
} from './leads.dto';
import { leadWriteErrorCode, mapLeadWriteError } from './lead-write-errors';
import {
  CODE_MOBILE_PAN_LIMIT_REACHED,
  LeadRuleError,
  MSG_MOBILE_PAN_LIMIT_REACHED,
} from './mobile-pan-limit';
import {
  leadFullNameError,
  personalLoanEmploymentError as checkPersonalLoanEmployment,
} from './personal-loan-employment';

/** Placeholder until user completes the second-step form */
export const LEAD_DRAFT_FULL_NAME = 'Unknown';
export const LEAD_DRAFT_PAN = 'XXXXX0000X';

export type LeadMutationActor = {
  sub?: string;
  email?: string;
  role?: string;
};

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly otpService: OtpService,
    private readonly panAudit: PanAuditService,
    private readonly usersService: UsersService,
    private readonly walletService: WalletService,
    private readonly servicesService: ServicesService,
  ) {}

  private get leads() {
    return this.supabase.from(TABLE_LEADS);
  }

  private safeLead(row: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!row) return null;
    return toSafeLeadRow(row);
  }

  private isApprovedStatus(status: unknown): boolean {
    return String(status ?? '').trim().toLowerCase() === 'approved';
  }

  /** Recalc partner wallet from all their approved leads (loan 2% / insurance ₹1000). */
  private async reconcileAgentWallet(agentId: unknown): Promise<void> {
    const uid = String(agentId ?? '').trim();
    if (!uid) return;
    await this.walletService.reconcileByUserId(uid);
  }

  private async syncWalletsForLeadChange(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): Promise<void> {
    if (!this.isApprovedStatus(before.status) && !this.isApprovedStatus(after.status)) {
      return;
    }
    const agents = new Set<string>();
    const oldAgent = String(before.agent_id ?? '').trim();
    const newAgent = String(after.agent_id ?? '').trim();
    if (oldAgent) agents.add(oldAgent);
    if (newAgent) agents.add(newAgent);
    for (const agentId of agents) {
      await this.reconcileAgentWallet(agentId);
    }
  }

  private isAdminActor(actor?: LeadMutationActor | null): boolean {
    return String(actor?.role ?? '').trim().toLowerCase() === 'admin';
  }

  private safeLeads(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return rows.map((r) => toSafeLeadRow(r));
  }

  /** IP only on the critical path — geo is filled async after write. */
  private ipFields(clientIp?: string | null): { ip?: string } {
    const ip = String(clientIp ?? '').trim().slice(0, 45);
    return ip ? { ip } : {};
  }

  /** Background geo fill from the saved visitor IP — never throws into apply/start. */
  private scheduleIpLocationFill(leadId: string | undefined | null, clientIp?: string | null): void {
    const id = leadId != null ? String(leadId).trim() : '';
    const ip = String(clientIp ?? '').trim().slice(0, 45);
    if (!id || !ip) return;

    void (async () => {
      try {
        const location = await resolveIpLocation(ip);
        if (!location) return;
        await this.leads.update({ ip_location: location }).eq('id', id);
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.error('scheduleIpLocationFill', err);
        }
      }
    })();
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

  private personalLoanEmploymentError(dto: {
    employmentType?: string | null;
    netMonthlyIncome?: number | null;
  }): string | null {
    return checkPersonalLoanEmployment(dto);
  }

  private storedOtpVerified(lead: Record<string, unknown>): boolean {
    const v = lead.otp_verified;
    return v === true || v === 1 || v === 'true';
  }

  /** Admin/partner CRM create — customer OTP is not required. */
  private async portalCreatedLeadIds(ids: string[]): Promise<Set<string>> {
    const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    const out = new Set<string>();
    if (!unique.length) return out;

    const { data, error } = await this.supabase
      .from(TABLE_PAN_ACCESS_AUDIT)
      .select('lead_id')
      .in('lead_id', unique)
      .eq('action', 'create')
      .eq('reason', 'admin_or_api_create');

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.portalCreatedLeadIds', error.message);
      }
      return out;
    }

    for (const row of data ?? []) {
      const id = String((row as { lead_id?: string }).lead_id ?? '').trim();
      if (id) out.add(id);
    }
    return out;
  }

  private async withOtpVerified(
    leads: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    if (!leads.length) return [];

    const unverified = leads.filter((l) => !this.storedOtpVerified(l));
    const mobiles = unverified.map((l) => String(l.mobile_number ?? ''));
    const unverifiedIds = unverified.map((l) => String(l.id ?? ''));

    const [verifiedAtByMobile, portalIds] = await Promise.all([
      mobiles.length
        ? this.otpService.getVerifiedAtByMobiles(mobiles)
        : Promise.resolve(new Map<string, string[]>()),
      this.portalCreatedLeadIds(unverifiedIds),
    ]);
    // Allow 2 minutes skew so OTP completed just before lead insert still counts.
    const SKEW_MS = 2 * 60 * 1000;

    return leads.map((lead) => {
      if (this.storedOtpVerified(lead)) {
        return { ...lead, otp_verified: true };
      }
      if (portalIds.has(String(lead.id ?? '').trim())) {
        return { ...lead, otp_verified: true };
      }
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

  categoryLabel(category: unknown): string {
    const c = this.normalizeCategory(String(category ?? ''));
    if (c === 'personal_loan') return 'Personal Loan';
    if (c === 'insurance') return 'Insurance';
    return c.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
  }

  insTypeLabel(insType: unknown): string {
    const t = String(insType ?? '')
      .trim()
      .toLowerCase();
    if (t === 'life_insurance') return 'Life Insurance';
    if (t === 'health_insurance') return 'Health Insurance';
    if (t === 'motor_insurance') return 'Motor Insurance';
    if (t === 'cyber_insurance') return 'Cyber Insurance';
    if (!t) return 'Insurance';
    return t.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
  }

  /** Personal Loan, or Life/Health/Motor/Cyber Insurance. */
  productLabel(lead: { category?: unknown; ins_type?: unknown }): string {
    const cat = this.normalizeCategory(String(lead.category ?? ''));
    if (cat === 'insurance') return this.insTypeLabel(lead.ins_type);
    return this.categoryLabel(cat);
  }

  statusLabel(status: unknown): string {
    const s = String(status ?? '')
      .trim()
      .toLowerCase();
    if (s === 'approved') return 'Approved';
    if (s === 'rejected') return 'Not Approved';
    if (s === 'in_process') return 'In Process';
    if (s === 'action_required') return 'Action Required';
    return 'Under Review';
  }

  private normalizeInsType(
    category: string,
    insType?: string | null,
  ): string | null {
    if (this.normalizeCategory(category) !== 'insurance') return null;
    const t = String(insType ?? '')
      .trim()
      .toLowerCase();
    return t || null;
  }

  /**
   * Gate 2 — same PAN + same product (any mobile):
   * - personal_loan vs personal_loan
   * - insurance + same ins_type (life / health / motor / cyber)
   * Different insurance types are allowed. Block unless prior lead is approved.
   * Does NOT block a different PAN merely because the mobile already has this product.
   * Scans open (non-approved) rows — not only the newest — so an older pending
   * still blocks after a later lead was approved.
   */
  async findBlockingSameCategoryLead(
    _mobileNumber: string,
    pan: string | null | undefined,
    category?: string | null,
    insType?: string | null,
  ): Promise<Record<string, unknown> | null> {
    const cat = this.normalizeCategory(category);
    const ins = this.normalizeInsType(cat, insType);
    const panUpper = pan ? normalizePan(pan) : '';
    if (!panUpper || !isValidPanFormat(panUpper)) return null;

    const pickOpen = (rows: Record<string, unknown>[] | null) => {
      for (const row of rows ?? []) {
        if (!this.isDraftLead(row) && !this.isApprovedStatus(row.status)) {
          return row;
        }
      }
      return null;
    };

    const digest = hashPan(panUpper);
    let byHash = this.leads
      .select()
      .eq('pan_hash', digest)
      .eq('category', cat)
      .eq('is_active', true)
      .neq('status', 'approved');
    if (cat === 'insurance' && ins) {
      byHash = byHash.eq('ins_type', ins);
    }
    const hashed = await byHash.order('created_at', { ascending: false }).limit(20);
    if (!hashed.error) {
      const hit = pickOpen((hashed.data as Record<string, unknown>[]) || []);
      if (hit) return hit;
    }

    let byPan = this.leads
      .select()
      .eq('pan', panUpper)
      .eq('category', cat)
      .eq('is_active', true)
      .neq('status', 'approved');
    if (cat === 'insurance' && ins) {
      byPan = byPan.eq('ins_type', ins);
    }
    const { data, error } = await byPan
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.findBlockingSameCategoryLead', error.message);
      }
      return null;
    }
    return pickOpen((data as Record<string, unknown>[]) || []);
  }

  blockingApplicationMessage(lead: Record<string, unknown>): string {
    const product = this.productLabel(lead);
    const status = this.statusLabel(lead.status);
    return `Your ${product} application is already ${status}. You can apply again for this product only after it is Approved.`;
  }

  private writeFailure(errorMessage?: string): {
    ok: false;
    message: string;
    code?: string;
  } {
    return {
      ok: false,
      message: mapLeadWriteError(errorMessage),
      code: leadWriteErrorCode(errorMessage),
    };
  }

  private async uniquePanHashesForMobile(mobileNumber: string): Promise<string[]> {
    const mobile = mobileNumber.trim();
    const { data, error } = await this.supabase
      .from(TABLE_LEAD_MOBILE_PAN_SLOTS)
      .select('pan_hash')
      .eq('mobile_number', mobile);

    if (!error && Array.isArray(data)) {
      return [
        ...new Set(
          data
            .map((row) => String((row as { pan_hash?: unknown }).pan_hash ?? '').trim())
            .filter(Boolean),
        ),
      ];
    }

    if (error && process.env.NODE_ENV !== 'production') {
      console.error('LeadsService.uniquePanHashesForMobile slots', error.message);
    }

    const { data: leads, error: leadsError } = await this.leads
      .select('pan_hash, pan, full_name')
      .eq('mobile_number', mobile)
      .eq('is_active', true);

    if (leadsError) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.uniquePanHashesForMobile leads', leadsError.message);
      }
      return [];
    }

    const hashes = new Set<string>();
    for (const row of (leads as Record<string, unknown>[]) || []) {
      if (this.isDraftLead(row)) continue;
      const hash = String(row.pan_hash ?? '').trim();
      if (hash) {
        hashes.add(hash);
        continue;
      }
      const pan = normalizePan(String(row.pan ?? ''));
      if (isValidPanFormat(pan)) hashes.add(hashPan(pan));
    }
    return [...hashes];
  }

  /** Gate 1 — max 4 unique real PAN fingerprints per mobile. Same PAN does not consume another slot. */
  async checkMobilePanLimit(
    mobileNumber: string,
    pan: string,
  ): Promise<{ allowed: true } | { allowed: false; message: string; code: string }> {
    const panUpper = normalizePan(pan);
    if (!isValidPanFormat(panUpper)) {
      return { allowed: true };
    }
    let panHash: string;
    try {
      panHash = hashPan(panUpper);
    } catch {
      return { allowed: true };
    }

    const hashes = await this.uniquePanHashesForMobile(mobileNumber);
    if (hashes.includes(panHash)) {
      return { allowed: true };
    }
    if (hashes.length >= 4) {
      return {
        allowed: false,
        message: MSG_MOBILE_PAN_LIMIT_REACHED,
        code: CODE_MOBILE_PAN_LIMIT_REACHED,
      };
    }
    return { allowed: true };
  }

  async evaluateApplicationGates(input: {
    mobileNumber: string;
    pan: string;
    category?: string | null;
    insType?: string | null;
    ignoreLeadId?: string;
  }): Promise<{
    allowed: boolean;
    message?: string;
    code?: string;
    status?: string;
    statusLabel?: string;
    category?: string;
    categoryLabel?: string;
    insType?: string | null;
  }> {
    const category = this.normalizeCategory(input.category);
    const ins = this.normalizeInsType(category, input.insType);
    if (category === 'insurance') {
      if (!ins) {
        return {
          allowed: false,
          message: 'Please select insurance type.',
          category,
          categoryLabel: this.categoryLabel(category),
        };
      }
      const insOk = await this.servicesService.isAllowedInsuranceType(ins);
      if (!insOk) {
        return {
          allowed: false,
          message: 'Invalid insurance type.',
          category,
          categoryLabel: this.categoryLabel(category),
        };
      }
    }

    const limit = await this.checkMobilePanLimit(input.mobileNumber, input.pan);
    if (!limit.allowed) {
      return {
        allowed: false,
        message: limit.message,
        code: limit.code,
        category,
        categoryLabel: this.categoryLabel(category),
        insType: ins,
      };
    }

    const blocking = await this.findBlockingSameCategoryLead(
      input.mobileNumber,
      input.pan,
      category,
      ins,
    );
    if (blocking && String(blocking['id'] ?? '') !== String(input.ignoreLeadId ?? '')) {
      const status =
        String(blocking.status ?? 'pending').trim().toLowerCase() || 'pending';
      return {
        allowed: false,
        message: this.blockingApplicationMessage(blocking),
        status,
        statusLabel: this.statusLabel(status),
        category,
        categoryLabel: this.productLabel(blocking),
        insType: this.normalizeInsType(category, String(blocking.ins_type ?? ins ?? '')),
      };
    }

    return { allowed: true, category, insType: ins };
  }

  async checkApplicationAllowed(input: {
    mobileNumber: string;
    pan: string;
    category?: string | null;
    insType?: string | null;
  }): Promise<{
    allowed: boolean;
    message?: string;
    code?: string;
    status?: string;
    statusLabel?: string;
    category?: string;
    categoryLabel?: string;
    insType?: string | null;
  }> {
    return this.evaluateApplicationGates(input);
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
    const c = String(category ?? '')
      .trim()
      .toLowerCase()
      .replace(/-/g, '_');
    return c || 'personal_loan';
  }

  /** Active lead for this mobile + product (+ insurance subtype when set). */
  async getByMobileAndCategory(
    mobileNumber: string,
    category: string,
    insType?: string | null,
  ): Promise<Record<string, unknown> | null> {
    const mobile = mobileNumber.trim();
    const cat = this.normalizeCategory(category);
    const ins = this.normalizeInsType(cat, insType);
    let q = this.leads
      .select()
      .eq('mobile_number', mobile)
      .eq('category', cat)
      .eq('is_active', true);
    if (cat === 'insurance' && ins) {
      q = q.eq('ins_type', ins);
    }
    const { data, error } = await q
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

  /** Active lead for this PAN + product (+ insurance subtype when set). */
  async getByPanAndCategory(
    pan: string,
    category: string,
    insType?: string | null,
  ): Promise<Record<string, unknown> | null> {
    const panUpper = normalizePan(pan);
    if (!isValidPanFormat(panUpper)) return null;
    const cat = this.normalizeCategory(category);
    const ins = this.normalizeInsType(cat, insType);
    const digest = hashPan(panUpper);

    let byHash = this.leads
      .select()
      .eq('pan_hash', digest)
      .eq('category', cat)
      .eq('is_active', true);
    if (cat === 'insurance' && ins) {
      byHash = byHash.eq('ins_type', ins);
    }
    const hashed = await byHash
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!hashed.error && hashed.data) {
      return hashed.data as Record<string, unknown>;
    }

    let byPan = this.leads
      .select()
      .eq('pan', panUpper)
      .eq('category', cat)
      .eq('is_active', true);
    if (cat === 'insurance' && ins) {
      byPan = byPan.eq('ins_type', ins);
    }
    const { data, error } = await byPan
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
   * Create lead after OTP.
   * Gate 1: max 4 unique PANs per mobile. Gate 2: same PAN + same product unless approved.
   */
  async applyLead(dto: CreateLeadDto, meta?: { clientIp?: string | null }): Promise<{
    ok: boolean;
    lead?: Record<string, unknown>;
    message?: string;
    code?: string;
  }> {
    const panUpper = normalizePan(dto.pan);
    if (!isValidPanFormat(panUpper)) {
      return { ok: false, message: 'Invalid PAN format.' };
    }

    const nameErr = leadFullNameError(dto.fullName);
    if (nameErr) return { ok: false, message: nameErr };

    const pin = String(dto.pincode ?? '').replace(/\D/g, '');
    if (!/^[1-9][0-9]{5}$/.test(pin)) {
      return { ok: false, message: 'Enter a valid 6-digit Indian pincode.' };
    }

    const mobile = dto.mobileNumber.trim();
    const category = this.normalizeCategory(dto.category);
    const ins = this.normalizeInsType(category, dto.insType);
    if (category === 'personal_loan') {
      const empErr = this.personalLoanEmploymentError(dto);
      if (empErr) return { ok: false, message: empErr };
    }
    if (category === 'insurance' && !ins) {
      return { ok: false, message: 'Please select insurance type.' };
    }

    // Prefer exact product match; fall back to untyped insurance draft for upgrade.
    let byMobile = await this.getByMobileAndCategory(mobile, category, ins);
    if ((!byMobile || !this.isDraftLead(byMobile)) && category === 'insurance' && ins) {
      const draftAny = await this.getByMobileAndCategory(mobile, category, null);
      if (draftAny && this.isDraftLead(draftAny)) {
        byMobile = draftAny;
      }
    }

    const gates = await this.evaluateApplicationGates({
      mobileNumber: mobile,
      pan: panUpper,
      category,
      insType: ins,
      ignoreLeadId:
        byMobile && this.isDraftLead(byMobile) && byMobile.id
          ? String(byMobile.id)
          : undefined,
    });
    if (!gates.allowed) {
      return {
        ok: false,
        message: gates.message,
        code: gates.code,
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
      pincode: pin,
      required_amount: dto.requiredAmount || null,
      category,
      status: 'pending',
      is_active: true,
      otp_verified: false,
    };

    // Public apply: never trust client-supplied userId (referral via code only).
    const agentId = await this.usersService.getIdByReferralCode(dto.referralCode);
    if (agentId) payload.agent_id = agentId;
    Object.assign(payload, this.ipFields(meta?.clientIp));
    if (category === 'personal_loan') {
      const amounts = resolvePersonalLoanAmounts({
        requiredAmount: dto.requiredAmount,
        loanAmt: dto.loanAmt,
      });
      const amtErr = personalLoanAmountError(amounts.requiredAmount);
      if (amtErr) return { ok: false, message: amtErr };
      payload.required_amount = amounts.requiredAmount;
      payload.loan_amt = amounts.loanAmt;
      payload.employment_type = dto.employmentType;
      payload.net_monthly_income = dto.netMonthlyIncome;
    }
    if (category === 'insurance') {
      payload.required_amount = null;
      payload.loan_amt = null;
      payload.ins_type = ins;
    }

    // Upgrade OTP/start draft for this category only — never overwrite another product.
    // Approved prior lead stays; only drafts are upgraded.
    if (byMobile && this.isDraftLead(byMobile) && byMobile.id) {
      try {
        const plAmounts =
          category === 'personal_loan'
            ? resolvePersonalLoanAmounts({
                requiredAmount: dto.requiredAmount,
                loanAmt: dto.loanAmt,
              })
            : null;
        const updated = await this.updateById(String(byMobile.id), {
          pan: panUpper,
          fullName: dto.fullName.trim(),
          email: dto.email,
          pincode: dto.pincode,
          requiredAmount: category === 'insurance' ? null : plAmounts?.requiredAmount ?? dto.requiredAmount,
          category,
          status: 'pending',
          loanAmt: category === 'personal_loan' ? plAmounts?.loanAmt ?? null : undefined,
          insType: category === 'insurance' ? ins : null,
          employmentType:
            category === 'personal_loan' ? dto.employmentType ?? null : null,
          netMonthlyIncome:
            category === 'personal_loan' ? dto.netMonthlyIncome ?? null : null,
          clientIp: meta?.clientIp ?? undefined,
          agentId: !byMobile.agent_id && agentId ? agentId : undefined,
        });
        if (!updated) {
          return {
            ok: false,
            message: mapLeadWriteError('update draft failed'),
          };
        }
        this.scheduleIpLocationFill(String(byMobile.id), meta?.clientIp);
        await this.panAudit.record({
          leadId: String(byMobile.id),
          action: 'update',
          reason: 'public_apply_upgrade_draft',
          metadata: { pan_masked: panFields.pan },
        });
        return { ok: true, lead: updated };
      } catch (err) {
        if (err instanceof LeadRuleError) {
          return { ok: false, message: err.message, code: err.code };
        }
        throw err;
      }
    }

    const { data, errorMessage } = await this.insertLead(payload, 'LeadsService.applyLead');
    if (!data) {
      return this.writeFailure(errorMessage);
    }

    const lead = data;
    if (lead.id) {
      this.scheduleIpLocationFill(String(lead.id), meta?.clientIp);
      await this.panAudit.record({
        leadId: String(lead.id),
        action: 'create',
        reason: 'public_apply',
        metadata: { pan_masked: panFields.pan },
      });
    }

    return { ok: true, lead: this.safeLead(lead)! };
  }

  async createDraft(
    mobileNumber: string,
    category: string,
    clientIp?: string | null,
    agentId?: string | null,
  ): Promise<Record<string, unknown> | null> {
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
    if (clientIp) Object.assign(payload, this.ipFields(clientIp));
    if (agentId) payload.agent_id = agentId;

    const { data, errorMessage } = await this.insertLead(payload, 'LeadsService.createDraft');
    if (!data) {
      console.error('LeadsService.createDraft failed:', errorMessage);
      return null;
    }

    this.scheduleIpLocationFill(data.id != null ? String(data.id) : null, clientIp);
    return this.safeLead(data);
  }

  async startLead(
    mobileNumber: string,
    category?: string,
    clientIp?: string | null,
    referralCode?: string,
  ): Promise<{
    ok: boolean;
    lead?: Record<string, unknown>;
    isDraft?: boolean;
    message?: string;
  }> {
    const cat = this.normalizeCategory(category);
    const existing = await this.getByMobileAndCategory(mobileNumber, cat);
    const agentId = await this.usersService.getIdByReferralCode(referralCode);

    if (existing) {
      // Reuse drafts. Do not block a new PAN merely because this mobile already
      // has an open application for the same product — PAN is checked on complete/apply.
      if (this.isDraftLead(existing)) {
        if (agentId && !existing.agent_id && existing.id) {
          const updated = await this.updateById(String(existing.id), { agentId });
          return {
            ok: true,
            lead: this.safeLead(updated ?? existing)!,
            isDraft: true,
          };
        }
        return {
          ok: true,
          lead: this.safeLead(existing)!,
          isDraft: true,
        };
      }
      // Prior completed lead — create a fresh draft for the next apply.
    }

    const created = await this.createDraft(mobileNumber, cat, clientIp, agentId);
    if (!created) return { ok: false, message: 'Failed to save mobile number.' };
    return { ok: true, lead: created, isDraft: true };
  }

  async completeLead(
    id: string,
    dto: CompleteLeadDto,
    meta?: { clientIp?: string | null },
  ): Promise<
    | { ok: true; lead: Record<string, unknown> }
    | { ok: false; message: string; code?: string }
  > {
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
    if (this.isApprovedStatus(row.status)) {
      return { ok: false, message: 'This application is already approved.' };
    }
    const mobile = String(row['mobile_number'] ?? '').trim();
    const category = this.normalizeCategory(
      dto.category?.trim() || String(row['category'] ?? ''),
    );
    const ins = this.normalizeInsType(category, dto.insType ?? String(row['ins_type'] ?? ''));
    if (category === 'personal_loan') {
      const empErr = this.personalLoanEmploymentError(dto);
      if (empErr) return { ok: false, message: empErr };
    }
    if (category === 'insurance' && !ins) {
      return { ok: false, message: 'Please select insurance type.' };
    }
    const gates = await this.evaluateApplicationGates({
      mobileNumber: mobile,
      pan: panUpper,
      category,
      insType: ins,
      ignoreLeadId: id,
    });
    if (!gates.allowed) {
      return {
        ok: false,
        message: gates.message || 'Application not allowed.',
        code: gates.code,
      };
    }

    const update: UpdateLeadDto = {
      pan: panUpper,
      fullName: dto.fullName.trim(),
      category: dto.category ?? category,
      status: 'pending',
      otpVerified: true,
    };

    if (dto.pincode?.trim()) {
      update.pincode = dto.pincode.trim();
    }
    if (meta?.clientIp) {
      update.clientIp = meta.clientIp;
    }
    if (!row.agent_id) {
      const agentId = await this.usersService.getIdByReferralCode(dto.referralCode);
      if (agentId) update.agentId = agentId;
    }

    if (category === 'personal_loan') {
      const amounts = resolvePersonalLoanAmounts({
        requiredAmount: dto.requiredAmount,
        loanAmt: dto.loanAmt,
      });
      update.requiredAmount = amounts.requiredAmount;
      update.loanAmt = amounts.loanAmt;
      update.insType = null;
      update.employmentType = dto.employmentType;
      update.netMonthlyIncome = dto.netMonthlyIncome;
    } else if (category === 'insurance') {
      update.insType = ins;
      update.loanAmt = null;
      update.requiredAmount = null;
      update.employmentType = null;
      update.netMonthlyIncome = null;
    }

    const lead = await this.updateById(id, update).catch((err) => {
      if (err instanceof LeadRuleError) {
        return err;
      }
      throw err;
    });
    if (lead instanceof LeadRuleError) {
      return { ok: false, message: lead.message, code: lead.code };
    }
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
      const empErr = this.personalLoanEmploymentError(dto);
      if (empErr) {
        throw new LeadRuleError(empErr);
      }
    }

    const nameErr = leadFullNameError(dto.fullName);
    if (nameErr) throw new LeadRuleError(nameErr);

    const gates = await this.evaluateApplicationGates({
      mobileNumber: dto.mobileNumber,
      pan: panUpper,
      category,
      insType: dto.insType,
    });
    if (!gates.allowed) {
      throw new LeadRuleError(
        gates.message || MSG_MOBILE_PAN_LIMIT_REACHED,
        gates.code,
      );
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
      // Admin/partner portal create, or OTP-gated public POST /leads.
      otp_verified: true,
    };

    // Public/admin insert: never trust client-supplied userId (commission IDOR).
    // Partner attribution is referralCode (public) or a later admin/agent patch.
    const agentId = await this.usersService.getIdByReferralCode(dto.referralCode);
    if (agentId) payload.agent_id = agentId;
    Object.assign(payload, this.ipFields(meta?.clientIp));

    if (category === 'personal_loan') {
      const amounts = resolvePersonalLoanAmounts({
        requiredAmount: dto.requiredAmount,
        loanAmt: dto.loanAmt,
      });
      const amtErr = personalLoanAmountError(amounts.requiredAmount);
      if (amtErr) throw new LeadRuleError(amtErr);
      payload.required_amount = amounts.requiredAmount;
      payload.loan_amt = amounts.loanAmt;
      payload.employment_type = dto.employmentType;
      payload.net_monthly_income = dto.netMonthlyIncome;
    }
    if (category === 'insurance' && dto.insType) {
      payload.ins_type = dto.insType;
    }

    const { data, errorMessage } = await this.insertLead(payload, 'LeadsService.create');
    if (!data) {
      console.error('LeadsService.create failed:', errorMessage);
      if (leadWriteErrorCode(errorMessage)) {
        throw new LeadRuleError(mapLeadWriteError(errorMessage), leadWriteErrorCode(errorMessage));
      }
      return null;
    }

    this.scheduleIpLocationFill(data.id != null ? String(data.id) : null, meta?.clientIp);

    if (data.id) {
      await this.panAudit.record({
        leadId: String(data.id),
        action: 'create',
        reason: 'admin_or_api_create',
        metadata: { pan_masked: panFields.pan },
      });
    }

    return this.safeLead({ ...data, otp_verified: true });
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
      console.error('LeadsService.getAll', error.message);
      return [];
    }

    const leads = (data as Record<string, unknown>[]) || [];
    const withOtp = await this.withOtpVerified(leads);
    const safe = this.safeLeads(withOtp);
    const withGeo = await this.enrichMissingIpLocations(safe);
    return this.enrichWithPartnerSource(withGeo);
  }

  /** Attach partner name / Direct for admin CRM view. */
  private async enrichWithPartnerSource(
    rows: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    const agentIds = [
      ...new Set(
        rows
          .map((r) => String(r.agent_id ?? '').trim())
          .filter(Boolean),
      ),
    ];
    const nameById = new Map<string, string>();
    if (agentIds.length > 0) {
      const { data, error } = await this.supabase
        .from('users')
        .select('id, user_name')
        .in('id', agentIds);
      if (error) {
        if (process.env.NODE_ENV !== 'production') {
          console.error('LeadsService.enrichWithPartnerSource', error.message);
        }
      } else {
        for (const u of data ?? []) {
          const id = String((u as { id?: unknown }).id ?? '').trim();
          const name = String((u as { user_name?: unknown }).user_name ?? '').trim();
          if (id) nameById.set(id, name || 'Partner');
        }
      }
    }

    return rows.map((row) => {
      const agentId = String(row.agent_id ?? '').trim();
      if (!agentId) {
        return {
          ...row,
          lead_source: 'Direct',
          partner_name: null,
        };
      }
      const partnerName = nameById.get(agentId) || 'Partner';
      return {
        ...row,
        lead_source: `Partner: ${partnerName}`,
        partner_name: partnerName,
      };
    });
  }

  async getByAgentId(agentId: string): Promise<Record<string, unknown>[]> {
    const id = agentId.trim();
    if (!id) return [];
    const { data, error } = await this.leads
      .select()
      .eq('agent_id', id)
      .eq('is_active', true)
      .order('created_at', { ascending: false });
    if (error) {
      console.error('LeadsService.getByAgentId', error.message);
      return [];
    }
    const leads = (data as Record<string, unknown>[]) || [];
    const withOtp = await this.withOtpVerified(leads);
    return this.safeLeads(withOtp);
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

    const ips = [...need.keys()].slice(0, 25);
    const byIp = await resolveIpLocationsBatch(ips, 4);
    const updates: Array<{ id: string; location: string }> = [];

    const out = rows.map((row) => {
      const ip = String(row.ip ?? '').trim();
      if (!ip || String(row.ip_location ?? '').trim()) return row;
      const location = byIp.get(ip);
      if (!location) return row;
      if (row.id != null) updates.push({ id: String(row.id), location });
      return { ...row, ip_location: location };
    });

    void Promise.all(
      updates.slice(0, 25).map(({ id, location }) =>
        this.leads.update({ ip_location: location }).eq('id', id).then(() => undefined),
      ),
    ).catch((err) => {
      console.error('enrichMissingIpLocations persist', err);
    });

    return out;
  }

  async updateById(
    id: string,
    dto: UpdateLeadDto,
    actor?: LeadMutationActor | null,
  ): Promise<Record<string, unknown> | null> {
    const existing = await this.getById(id);
    if (!existing) return null;

    const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (dto.fullName != null) payload.full_name = dto.fullName.trim();
    if (dto.email !== undefined) payload.email = dto.email?.trim() || null;
    if (dto.mobileNumber != null) {
      payload.mobile_number = dto.mobileNumber.trim();
    }
    if (dto.pincode !== undefined) payload.pincode = dto.pincode?.trim() || null;
    if (dto.clientIp !== undefined) {
      const trimmed = dto.clientIp?.trim() || null;
      if (!trimmed) {
        payload.ip = null;
        payload.ip_location = null;
      } else {
        Object.assign(payload, this.ipFields(trimmed));
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
    if (dto.agentId) payload.agent_id = dto.agentId.trim();
    if (dto.otpVerified === true) payload.otp_verified = true;

    const nextStatus = String(payload.status ?? existing.status ?? '').trim();
    const nextAgent = String(payload.agent_id ?? existing.agent_id ?? '').trim();
    const nextCategory = this.normalizeCategory(
      String(payload.category ?? existing.category ?? ''),
    );
    if (nextCategory === 'personal_loan') {
      const amounts = resolvePersonalLoanAmounts({
        requiredAmount:
          payload.required_amount !== undefined
            ? (payload.required_amount as number | null)
            : Number(existing.required_amount) || null,
        loanAmt:
          payload.loan_amt !== undefined
            ? (payload.loan_amt as string | null)
            : String(existing.loan_amt ?? '') || null,
      });
      if (amounts.requiredAmount != null) {
        payload.required_amount = amounts.requiredAmount;
      }
    }

    const moneyChange = isCommissionAffectingChange(
      { status: existing.status, agent_id: existing.agent_id },
      { status: nextStatus, agent_id: nextAgent },
    );
    if (
      requiresAdminCommissionGate(
        {
          status: existing.status,
          agent_id: existing.agent_id,
          required_amount: existing.required_amount,
          loan_amt: existing.loan_amt,
          category: existing.category,
        },
        {
          status: nextStatus,
          agent_id: nextAgent,
          required_amount: payload.required_amount ?? existing.required_amount,
          loan_amt: payload.loan_amt ?? existing.loan_amt,
          category: nextCategory,
        },
      ) &&
      !this.isAdminActor(actor)
    ) {
      throw new LeadRuleError(MSG_APPROVE_ADMIN_ONLY, CODE_APPROVE_ADMIN_ONLY);
    }
    if (
      moneyChange &&
      this.isApprovedStatus(nextStatus) &&
      !this.isApprovedStatus(existing.status) &&
      nextCategory === 'personal_loan' &&
      leadLoanAmount({
        required_amount: payload.required_amount ?? existing.required_amount,
        loan_amt: payload.loan_amt ?? existing.loan_amt,
      }) <= 0
    ) {
      throw new LeadRuleError(MSG_LOAN_AMOUNT_REQUIRED, CODE_LOAN_AMOUNT_REQUIRED);
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
        const ins = this.normalizeInsType(
          category,
          dto.insType ??
            (payload.ins_type as string | undefined) ??
            String(existing['ins_type'] ?? ''),
        );
        const other = await this.findBlockingSameCategoryLead(
          '',
          panUpper,
          category,
          ins,
        );
        if (other && String(other.id) !== id) {
          return null;
        }
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

    const nextMobile = String(
      payload.mobile_number ?? existing['mobile_number'] ?? '',
    ).trim();
    const nextPanHash = String(
      payload.pan_hash ?? existing['pan_hash'] ?? '',
    ).trim();
    if (nextMobile && nextPanHash) {
      const hashes = await this.uniquePanHashesForMobile(nextMobile);
      if (!hashes.includes(nextPanHash) && hashes.length >= 4) {
        throw new LeadRuleError(
          MSG_MOBILE_PAN_LIMIT_REACHED,
          CODE_MOBILE_PAN_LIMIT_REACHED,
        );
      }
    }

    const { data, errorMessage } = await this.updateLeadRow(
      id,
      payload,
      'LeadsService.updateById',
    );
    if (!data) {
      console.error('LeadsService.updateById failed:', errorMessage);
      if (leadWriteErrorCode(errorMessage)) {
        throw new LeadRuleError(
          mapLeadWriteError(errorMessage),
          leadWriteErrorCode(errorMessage),
        );
      }
      return null;
    }

    if (dto.clientIp) {
      this.scheduleIpLocationFill(id, dto.clientIp);
    }

    if (panChanged && data.id) {
      await this.panAudit.record({
        leadId: String(data.id),
        action: 'update',
        reason: 'pan_rotated',
        metadata: { pan_masked: panMasked },
      });
    }

    const fromStatus = String(existing.status ?? '').trim();
    const toStatus = String((data as Record<string, unknown>).status ?? nextStatus).trim();

    try {
      await this.syncWalletsForLeadChange(existing, data as Record<string, unknown>);
    } catch (err) {
      this.logger.error(
        `Wallet sync failed lead=${id} agent=${nextAgent} actor=${actor?.email ?? actor?.sub ?? 'unknown'}`,
        err instanceof Error ? err.stack : undefined,
      );
      if (moneyChange && fromStatus !== toStatus) {
        const reverted = await this.updateLeadRow(
          id,
          { status: fromStatus, updated_at: new Date().toISOString() },
          'LeadsService.updateById.revertWallet',
        );
        if (reverted.data) {
          try {
            await this.syncWalletsForLeadChange(
              data as Record<string, unknown>,
              reverted.data,
            );
          } catch (revertErr) {
            this.logger.error(
              `Wallet revert reconcile failed lead=${id}`,
              revertErr instanceof Error ? revertErr.stack : undefined,
            );
            throw new WalletSyncError(MSG_WALLET_SYNC_FAILED_STATUS_SAVED, true);
          }
          throw new WalletSyncError(
            err instanceof WalletSyncError ? err.message : MSG_WALLET_SYNC_FAILED,
            false,
          );
        }
      }
      throw new WalletSyncError(MSG_WALLET_SYNC_FAILED_STATUS_SAVED, true);
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
    const existing = await this.getById(id);
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

    const ok = Array.isArray(data) && data.length > 0;
    if (ok && existing && this.isApprovedStatus(existing.status)) {
      try {
        await this.reconcileAgentWallet(existing.agent_id);
      } catch (err) {
        this.logger.error(
          `Wallet sync failed after deleting approved lead=${id}`,
          err instanceof Error ? err.stack : undefined,
        );
        throw new WalletSyncError(MSG_WALLET_SYNC_FAILED_STATUS_SAVED, true);
      }
    }
    return ok;
  }
}
