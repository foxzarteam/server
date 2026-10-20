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
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { ServicesService } from '../services/services.service';
import {
  CODE_LOAN_AMOUNT_REQUIRED,
  leadLoanAmount,
  MSG_LOAN_AMOUNT_REQUIRED,
  isStoredLoanCategory,
  personalLoanAmountError,
  resolvePersonalLoanAmounts,
} from '../wallet/loan-amount';
import { commissionInputError } from '../wallet/lead-commission';
import {
  CODE_APPROVE_ADMIN_ONLY,
  isCommissionAffectingChange,
  MSG_APPROVE_ADMIN_ONLY,
  MSG_WALLET_SYNC_FAILED,
  MSG_WALLET_SYNC_FAILED_STATUS_SAVED,
  requiresAdminCommissionGate,
  WalletSyncError,
} from '../wallet/wallet-sync';
import {
  AdminCreateLeadDto,
  CreateLeadDto,
  UpdateLeadDto,
} from './leads.dto';
import { leadWriteErrorCode, mapLeadWriteError } from './lead-write-errors';
import {
  CODE_MOBILE_PAN_LIMIT_REACHED,
  CODE_PHONE_PRODUCT_BLOCKED,
  LeadRuleError,
  MSG_MOBILE_PAN_LIMIT_REACHED,
} from './mobile-pan-limit';
import {
  leadFullNameError,
  loanNotEligibleMessage,
  loanProfileError,
  personalLoanEmploymentError,
  readCibilReport,
  storedCibilBand,
  storedEmploymentType,
  type CibilReportFile,
} from './personal-loan-employment';
import { openCibilObject, uploadCibilReport } from '../storage/r2-cibil';
import type { Readable } from 'node:stream';
import { LEAD_DRAFT_PAN } from './lead-draft';
import {
  blockingApplicationMessage,
  categoryLabel,
  categoryLookupKeys,
  insTypeLookupKeys,
  isDraftLead,
  normalizeStoredCategory,
  normalizeStoredInsType,
  productLabel,
  statusLabel,
} from './lead-present';
import { isApprovedLeadStatus } from '../common/lead-status';

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
    private readonly whatsapp: WhatsappService,
  ) {}

  private get leads() {
    return this.supabase.from(TABLE_LEADS);
  }

  private safeLead(row: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!row) return null;
    return toSafeLeadRow(row);
  }

  /** Recalc partner wallet from approved leads. */
  private async reconcileAgentWallet(agentId: unknown): Promise<void> {
    const uid = String(agentId ?? '').trim();
    if (!uid) return;
    await this.walletService.reconcileByUserId(uid);
  }

  private async syncWalletsForLeadChange(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): Promise<void> {
    if (!isApprovedLeadStatus(before.status) && !isApprovedLeadStatus(after.status)) {
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

  /** Admin create, and public apply only after OTP marks the lead verified. */
  private notifyApplicationWhatsapp(
    lead: Record<string, unknown> | null | undefined,
    fallbackPhone = '',
    fallbackName = '',
  ): void {
    if (!lead) return;
    const category = normalizeStoredCategory(String(lead.category ?? ''));
    this.whatsapp.notifyApplicationKycStart({
      leadId: String(lead.id ?? ''),
      phone: String(lead.mobile_number ?? lead.mobileNumber ?? fallbackPhone ?? ''),
      name: String(lead.full_name ?? lead.fullName ?? fallbackName ?? ''),
      category,
      insType: lead.ins_type != null ? String(lead.ins_type) : null,
    });
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
      if (this.keepMissingColumn(col)) {
        console.error(`${logLabel}: leads.${col} column is missing`);
        return { data: null, errorMessage: error.message };
      }
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
      if (this.keepMissingColumn(col)) {
        console.error(`${logLabel}: leads.${col} column is missing`);
        return { data: null, errorMessage: error.message };
      }
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

  private keepMissingColumn(col: string | null): boolean {
    return (
      col === 'consent_accepted' ||
      col === 'cibil_band' ||
      col === 'has_existing_emi' ||
      col === 'total_monthly_emi' ||
      col === 'cibil_report_name'
    );
  }

  private loanProfileColumns(
    dto: {
      cibilBand?: string | null;
      hasExistingEmi?: boolean | null;
      totalMonthlyEmi?: number | null;
    },
    reportName: string | null,
  ): Record<string, unknown> {
    const noEmi = dto.hasExistingEmi === false;
    return {
      cibil_band: storedCibilBand(dto.cibilBand),
      has_existing_emi: dto.hasExistingEmi === true,
      total_monthly_emi: noEmi ? 0 : Math.round(Number(dto.totalMonthlyEmi)),
      cibil_report_name: reportName,
    };
  }

  /** Optional CIBIL file goes to private R2. The lead row stores only the object path. */
  private async attachCibilReport(
    lead: Record<string, unknown>,
    file: CibilReportFile | null,
    deleteLeadOnFailure: boolean,
  ): Promise<string | null> {
    if (!file) return null;
    const leadId = String(lead.id ?? '').trim();
    if (!leadId) {
      return 'Could not save the CIBIL report. Try a PDF or image, or submit without the file.';
    }
    const uploaded = await uploadCibilReport(leadId, file);
    if ('key' in uploaded) {
      const { error } = await this.leads.update({ cibil_report_name: uploaded.key }).eq('id', leadId);
      if (!error) {
        lead.cibil_report_name = uploaded.key;
        return null;
      }
    }
    if (deleteLeadOnFailure) {
      await this.leads.delete().eq('id', leadId);
    }
    return 'Could not save the CIBIL report. Try a PDF or image, or submit without the file.';
  }

  private async personalLoanAmountBounds(): Promise<{ min: number; max: number } | undefined> {
    const bounds = await this.servicesService.amountBoundsBySlug('personal-loan');
    return bounds ?? undefined;
  }

  /** Public apply: amount must sit inside that product's limit_start / limit_end. */
  private async publicLoanAmounts(
    category: string,
    dto: { requiredAmount?: number | null; loanAmt?: string | null },
  ): Promise<
    | { ok: true; amounts: { requiredAmount: number | null; loanAmt: string | null } }
    | { ok: false; message: string }
    | null
  > {
    if (!isStoredLoanCategory(category)) return null;
    const amounts = resolvePersonalLoanAmounts({
      requiredAmount: dto.requiredAmount,
      loanAmt: dto.loanAmt,
    });
    const bounds = await this.servicesService.amountBoundsBySlug(category.replace(/_/g, '-'));
    const amtErr = personalLoanAmountError(amounts.requiredAmount, bounds ?? undefined);
    if (amtErr) return { ok: false, message: amtErr };
    return { ok: true, amounts };
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

  /**
   * Same mobile + same product. PAN is not checked.
   * Newest real lead wins: approved allows another apply, rejected blocks forever,
   * any other open status blocks and the caller shows that status.
   * Insurance types (life / health / motor) are separate products.
   */
  async findBlockingSameCategoryLead(
    mobileNumber: string,
    _pan: string | null | undefined,
    category?: string | null,
    insType?: string | null,
    ignoreLeadId?: string,
  ): Promise<Record<string, unknown> | null> {
    const mobile = mobileNumber.trim();
    if (!mobile) return null;
    const cat = normalizeStoredCategory(category);
    const ins = normalizeStoredInsType(cat, insType);
    const ignore = String(ignoreLeadId ?? '').trim();

    let q = this.leads
      .select()
      .eq('mobile_number', mobile)
      .in('category', categoryLookupKeys(cat))
      .eq('is_active', true);
    if (cat === 'insurance' && ins) {
      q = q.in('ins_type', insTypeLookupKeys(ins));
    }
    const { data, error } = await q.order('created_at', { ascending: false }).limit(20);
    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('LeadsService.findBlockingSameCategoryLead', error.message);
      }
      return null;
    }

    for (const row of (data as Record<string, unknown>[]) || []) {
      if (ignore && String(row.id ?? '').trim() === ignore) continue;
      if (isDraftLead(row)) continue;
      if (isApprovedLeadStatus(row.status)) return null;
      return row;
    }
    return null;
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
      if (isDraftLead(row)) continue;
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
    const category = normalizeStoredCategory(input.category);
    let ins = normalizeStoredInsType(category, input.insType);
    if (category === 'insurance' && !ins) {
      return {
        allowed: false,
        message: 'Please select insurance type.',
        category,
        categoryLabel: categoryLabel(category),
      };
    }
    if (category === 'insurance' && ins) {
      const stored = await this.servicesService.resolveInsuranceTypeSlug(ins);
      if (!stored) {
        return {
          allowed: false,
          message: 'Invalid insurance type.',
          category,
          categoryLabel: categoryLabel(category),
        };
      }
      ins = stored;
    }

    const blocking = await this.findBlockingSameCategoryLead(
      input.mobileNumber,
      input.pan,
      category,
      ins,
      input.ignoreLeadId,
    );
    if (blocking) {
      const status =
        String(blocking.status ?? 'pending').trim().toLowerCase() || 'pending';
      return {
        allowed: false,
        message: blockingApplicationMessage(blocking),
        code: CODE_PHONE_PRODUCT_BLOCKED,
        status,
        statusLabel: statusLabel(status),
        category,
        categoryLabel: productLabel(blocking),
        insType: normalizeStoredInsType(category, String(blocking.ins_type ?? ins ?? '')),
      };
    }

    return { allowed: true, category, insType: ins };
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

  /** Private CIBIL file for admin, staff, or the partner who owns the lead. */
  async openCibilReport(
    leadId: string,
    actor: { sub: string; role: string },
  ): Promise<
    | { ok: true; stream: Readable; mime: string; filename: string; size: number | null }
    | { ok: false; status: 403 | 404; message: string }
  > {
    const lead = await this.getById(leadId);
    if (!lead) return { ok: false, status: 404, message: 'CIBIL report not found.' };

    const role = String(actor.role ?? '').trim().toLowerCase();
    if (role === 'agent') {
      const owner = String(lead.agent_id ?? '').trim();
      if (!owner || owner !== actor.sub.trim()) {
        return { ok: false, status: 404, message: 'CIBIL report not found.' };
      }
    } else if (role !== 'admin' && role !== 'staff') {
      return { ok: false, status: 403, message: 'Unauthorized' };
    }

    const key = String(lead.cibil_report_name ?? '').trim();
    if (!key) return { ok: false, status: 404, message: 'No CIBIL report on this lead.' };

    const file = await openCibilObject(key);
    if ('error' in file) {
      return { ok: false, status: 404, message: 'Could not download the CIBIL report.' };
    }
    return { ok: true, stream: file.stream, mime: file.mime, filename: file.filename, size: file.size };
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

  /** Active lead for this mobile + product (+ insurance subtype when set). */
  async getByMobileAndCategory(
    mobileNumber: string,
    category: string,
    insType?: string | null,
  ): Promise<Record<string, unknown> | null> {
    const mobile = mobileNumber.trim();
    const cat = normalizeStoredCategory(category);
    const ins = normalizeStoredInsType(cat, insType);
    let q = this.leads
      .select()
      .eq('mobile_number', mobile)
      .in('category', categoryLookupKeys(cat))
      .eq('is_active', true);
    if (cat === 'insurance' && ins) {
      q = q.in('ins_type', insTypeLookupKeys(ins));
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
    const cat = normalizeStoredCategory(category);
    const ins = normalizeStoredInsType(cat, insType);
    const digest = hashPan(panUpper);

    let byHash = this.leads
      .select()
      .eq('pan_hash', digest)
      .in('category', categoryLookupKeys(cat))
      .eq('is_active', true);
    if (cat === 'insurance' && ins) {
      byHash = byHash.in('ins_type', insTypeLookupKeys(ins));
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
      .in('category', categoryLookupKeys(cat))
      .eq('is_active', true);
    if (cat === 'insurance' && ins) {
      byPan = byPan.in('ins_type', insTypeLookupKeys(ins));
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
   * One mobile can hold one open application per product. Approved can apply again. Rejected cannot.
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
    if (dto.consentAccepted !== true) {
      return {
        ok: false,
        message: 'Please agree to the T&C and Privacy Policy to continue.',
      };
    }

    const category = normalizeStoredCategory(dto.category);
    let ins = normalizeStoredInsType(category, dto.insType);
    if (isStoredLoanCategory(category)) {
      const empErr = personalLoanEmploymentError(dto);
      if (empErr) return { ok: false, message: empErr };
    }
    if (category === 'insurance' && !ins) {
      return { ok: false, message: 'Please select insurance type.' };
    }

    // Prefer exact product match; fall back to untyped insurance draft for upgrade.
    const [byMobileHit, agentId] = await Promise.all([
      this.getByMobileAndCategory(mobile, category, ins),
      this.usersService.getIdByReferralCode(dto.referralCode),
    ]);
    let byMobile = byMobileHit;
    if ((!byMobile || !isDraftLead(byMobile)) && category === 'insurance' && ins) {
      const draftAny = await this.getByMobileAndCategory(mobile, category, null);
      if (draftAny && isDraftLead(draftAny)) {
        byMobile = draftAny;
      }
    }

    const gates = await this.evaluateApplicationGates({
      mobileNumber: mobile,
      pan: panUpper,
      category,
      insType: ins,
      ignoreLeadId:
        byMobile && isDraftLead(byMobile) && byMobile.id
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
    if (gates.insType) ins = gates.insType;

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
      consent_accepted: true,
    };

    // Public apply: never trust client-supplied userId (referral via code only).
    if (agentId) payload.agent_id = agentId;
    Object.assign(payload, this.ipFields(meta?.clientIp));
    const publicLoan = await this.publicLoanAmounts(category, dto);
    if (publicLoan && !publicLoan.ok) return { ok: false, message: publicLoan.message };
    let cibilFile: CibilReportFile | null = null;
    if (publicLoan?.ok) {
      const profileErr = loanProfileError(dto);
      if (profileErr) return { ok: false, message: profileErr };
      const notEligible = loanNotEligibleMessage(dto);
      if (notEligible) return { ok: false, message: notEligible };
      const report = readCibilReport(dto);
      if (!report.ok) return { ok: false, message: report.message };
      cibilFile = report.file;
      payload.required_amount = publicLoan.amounts.requiredAmount;
      payload.loan_amt = publicLoan.amounts.loanAmt;
      payload.net_monthly_income = dto.netMonthlyIncome;
      const employment = storedEmploymentType(dto.employmentType);
      if (employment) payload.employment_type = employment;
      Object.assign(payload, this.loanProfileColumns(dto, null));
    }
    if (category === 'insurance') {
      payload.required_amount = null;
      payload.loan_amt = null;
      payload.ins_type = ins;
    }

    // Upgrade OTP/start draft for this category only — never overwrite another product.
    // Approved prior lead stays; only drafts are upgraded.
    if (byMobile && isDraftLead(byMobile) && byMobile.id) {
      try {
        const loanAmounts = publicLoan?.ok ? publicLoan.amounts : null;
        const updated = await this.updateById(String(byMobile.id), {
          pan: panUpper,
          fullName: dto.fullName.trim(),
          email: dto.email,
          pincode: dto.pincode,
          requiredAmount: category === 'insurance' ? null : loanAmounts?.requiredAmount ?? dto.requiredAmount,
          category,
          status: 'pending',
          loanAmt: loanAmounts ? loanAmounts.loanAmt : undefined,
          insType: category === 'insurance' ? ins : null,
          netMonthlyIncome: loanAmounts ? dto.netMonthlyIncome ?? null : null,
          employmentType: loanAmounts ? dto.employmentType : undefined,
          cibilBand: loanAmounts ? dto.cibilBand : undefined,
          hasExistingEmi: loanAmounts ? dto.hasExistingEmi : undefined,
          totalMonthlyEmi: loanAmounts ? dto.totalMonthlyEmi : undefined,
          cibilReportName: loanAmounts ? null : undefined,
          clientIp: meta?.clientIp ?? undefined,
          agentId: !byMobile.agent_id && agentId ? agentId : undefined,
          consentAccepted: true,
        });
        if (!updated) {
          return {
            ok: false,
            message: mapLeadWriteError('update draft failed'),
          };
        }
        this.scheduleIpLocationFill(String(byMobile.id), meta?.clientIp);
        const fileErr = await this.attachCibilReport(updated, cibilFile, false);
        if (fileErr) return { ok: false, message: fileErr };
        void this.panAudit.record({
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
      const fileErr = await this.attachCibilReport(lead, cibilFile, true);
      if (fileErr) return { ok: false, message: fileErr };
      this.scheduleIpLocationFill(String(lead.id), meta?.clientIp);
      void this.panAudit.record({
        leadId: String(lead.id),
        action: 'create',
        reason: 'public_apply',
        metadata: { pan_masked: panFields.pan },
      });
    }
    return { ok: true, lead: this.safeLead(lead)! };
  }

  /**
   * Same PAN / mobile / product rules as create, without inserting a lead.
   */
  async validateAdminCreate(dto: AdminCreateLeadDto): Promise<
    | { ok: true }
    | { ok: false; message: string; field?: string; code?: string }
  > {
    const panUpper = normalizePan(dto.pan);
    if (!isValidPanFormat(panUpper)) {
      return { ok: false, field: 'pan', message: 'Invalid PAN format.' };
    }

    const nameErr = leadFullNameError(dto.fullName);
    if (nameErr) return { ok: false, message: nameErr };

    const category = normalizeStoredCategory(dto.category || 'personal_loan');
    if (category === 'personal_loan') {
      const empErr = personalLoanEmploymentError(dto);
      if (empErr) {
        return {
          ok: false,
          field: /income/i.test(empErr) ? 'netMonthlyIncome' : 'employmentType',
          message: empErr,
        };
      }
      const amounts = resolvePersonalLoanAmounts({
        requiredAmount: dto.requiredAmount,
        loanAmt: dto.loanAmt,
      });
      const amtErr = personalLoanAmountError(amounts.requiredAmount, await this.personalLoanAmountBounds());
      if (amtErr) return { ok: false, message: amtErr };
    }
    if (category === 'insurance' && !normalizeStoredInsType(category, dto.insType)) {
      return { ok: false, message: 'Please select insurance type.' };
    }

    const pin = String(dto.pincode ?? '').replace(/\D/g, '');
    if (!/^[1-9][0-9]{5}$/.test(pin)) {
      return {
        ok: false,
        field: 'pincode',
        message: pin ? 'Enter a valid 6-digit Indian pincode.' : 'Pincode is required.',
      };
    }

    const gates = await this.evaluateApplicationGates({
      mobileNumber: dto.mobileNumber,
      pan: panUpper,
      category,
      insType: category === 'insurance' ? dto.insType ?? null : null,
    });
    if (!gates.allowed) {
      return {
        ok: false,
        field: 'mobileNumber',
        message: gates.message || MSG_MOBILE_PAN_LIMIT_REACHED,
        code: gates.code,
      };
    }

    return { ok: true };
  }

  async create(dto: CreateLeadDto, meta?: { clientIp?: string | null; agentId?: string | null }): Promise<Record<string, unknown> | null> {
    const panUpper = normalizePan(dto.pan);
    if (!isValidPanFormat(panUpper)) {
      return null;
    }

    const category = normalizeStoredCategory(dto.category || 'personal_loan');
    if (category === 'personal_loan') {
      const empErr = personalLoanEmploymentError(dto);
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
      // Partner or admin add-lead: verified and consent are yes by default.
      otp_verified: true,
      consent_accepted: true,
    };

    // Public/admin insert: never trust client-supplied userId (commission IDOR).
    // Partner app passes agentId from the session token. Public apply uses referralCode.
    const forcedAgent = meta?.agentId?.trim();
    if (forcedAgent) {
      payload.agent_id = forcedAgent;
    } else {
      const agentId = await this.usersService.getIdByReferralCode(dto.referralCode);
      if (agentId) payload.agent_id = agentId;
    }
    Object.assign(payload, this.ipFields(meta?.clientIp));

    if (category === 'personal_loan') {
      const amounts = resolvePersonalLoanAmounts({
        requiredAmount: dto.requiredAmount,
        loanAmt: dto.loanAmt,
      });
      const amtErr = personalLoanAmountError(amounts.requiredAmount, await this.personalLoanAmountBounds());
      if (amtErr) throw new LeadRuleError(amtErr);
      payload.required_amount = amounts.requiredAmount;
      payload.loan_amt = amounts.loanAmt;
      payload.net_monthly_income = dto.netMonthlyIncome;
      const employment = storedEmploymentType(dto.employmentType);
      if (employment) payload.employment_type = employment;
    }
    if (category === 'insurance' && (gates.insType || dto.insType)) {
      payload.ins_type = gates.insType || dto.insType;
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
    this.notifyApplicationWhatsapp(data, dto.mobileNumber, dto.fullName);
    return this.safeLead({ ...data, otp_verified: true });
  }

  /** Partner app / panel: always pending, always attributed to this agent. */
  async createForPartner(
    dto: AdminCreateLeadDto,
    agentId: string,
  ): Promise<{
    ok: true;
    lead: Record<string, unknown>;
  } | {
    ok: false;
    message: string;
    code?: string;
    field?: string;
  }> {
    const uid = agentId.trim();
    if (!uid) {
      return { ok: false, message: 'Unauthorized' };
    }

    const category = normalizeStoredCategory(dto.category || 'personal_loan');
    const insType = category === 'insurance' ? dto.insType ?? null : null;
    const gates = await this.evaluateApplicationGates({
      mobileNumber: dto.mobileNumber,
      pan: dto.pan,
      category,
      insType,
    });
    if (!gates.allowed) {
      return {
        ok: false,
        field: 'mobileNumber',
        message: gates.message || MSG_MOBILE_PAN_LIMIT_REACHED,
        code: gates.code,
      };
    }

    let created: Record<string, unknown> | null;
    try {
      created = await this.create(
        {
          pan: dto.pan,
          mobileNumber: dto.mobileNumber,
          fullName: dto.fullName,
          email: dto.email,
          pincode: dto.pincode,
          requiredAmount: dto.requiredAmount,
          category: dto.category,
          loanAmt: dto.loanAmt,
          insType: dto.insType,
          netMonthlyIncome: dto.netMonthlyIncome,
          employmentType: dto.employmentType,
          consentAccepted: true,
        },
        { agentId: uid },
      );
    } catch (err) {
      if (err instanceof LeadRuleError) {
        return {
          ok: false,
          field: err.code === CODE_MOBILE_PAN_LIMIT_REACHED || err.code === CODE_PHONE_PRODUCT_BLOCKED ? 'mobileNumber' : 'pan',
          message: err.message,
          code: err.code,
        };
      }
      throw err;
    }

    if (!created?.id) {
      return {
        ok: false,
        message: 'Failed to create lead. Check PAN / mobile and try again.',
      };
    }

    return { ok: true, lead: created };
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

  /**
   * Admin Excel export. Decrypts PAN for the file only.
   * Each decrypted PAN is audited. Plaintext is never logged.
   * If the audit insert fails, nothing is returned.
   */
  async exportAllForAdmin(actor: {
    adminId?: string;
    adminEmail?: string;
    adminRole?: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<
    { ok: true; rows: Record<string, unknown>[] } | { ok: false; message: string }
  > {
    const { data, error } = await this.leads
      .select()
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('LeadsService.exportAllForAdmin', error.message);
      return { ok: false, message: 'Could not load leads' };
    }

    const leads = (data as Record<string, unknown>[]) || [];
    const withOtp = await this.withOtpVerified(leads);
    const withGeo = await this.enrichMissingIpLocations(withOtp);
    const withPartner = await this.enrichWithPartnerSource(withGeo);

    const audits: Array<{
      leadId: string;
      action: 'reveal' | 'decrypt_failed';
      panMasked?: string;
    }> = [];
    const rows: Record<string, unknown>[] = [];

    for (const row of withPartner) {
      const revealed = this.plainPanForExport(row);
      const leadId = String(row.id ?? '').trim();
      if (revealed.audit) {
        if (!leadId) {
          revealed.pan = '';
        } else {
          audits.push({
            leadId,
            action: revealed.audit,
            panMasked: revealed.pan ? maskPan(revealed.pan) : undefined,
          });
        }
      }
      const safe = toSafeLeadRow(row);
      safe.pan = revealed.pan;
      rows.push(safe);
    }

    const audited = await this.panAudit.recordMany(
      audits.map((entry) => ({
        leadId: entry.leadId,
        action: entry.action,
        adminId: actor.adminId,
        adminEmail: actor.adminEmail,
        adminRole: actor.adminRole,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        reason: 'admin_excel_export',
        metadata: {
          bulk: true,
          ...(entry.panMasked ? { pan_masked: entry.panMasked } : {}),
        },
      })),
    );
    if (!audited) {
      return { ok: false, message: 'Audit logging failed; export stopped' };
    }

    return { ok: true, rows };
  }

  /** Full PAN for export. Draft / masked-only rows stay blank. */
  private plainPanForExport(row: Record<string, unknown>): {
    pan: string;
    audit: 'reveal' | 'decrypt_failed' | null;
  } {
    if (isDraftLead(row)) return { pan: '', audit: null };
    const encrypted = row.pan_encrypted != null ? String(row.pan_encrypted).trim() : '';
    if (encrypted) {
      try {
        return { pan: decryptPan(encrypted), audit: 'reveal' };
      } catch {
        return { pan: '', audit: 'decrypt_failed' };
      }
    }
    const legacy = normalizePan(String(row.pan ?? ''));
    if (isValidPanFormat(legacy) && legacy !== LEAD_DRAFT_PAN) {
      return { pan: legacy, audit: 'reveal' };
    }
    return { pan: '', audit: null };
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
    if (dto.netMonthlyIncome !== undefined) {
      payload.net_monthly_income = dto.netMonthlyIncome ?? null;
    }
    if (dto.employmentType !== undefined) {
      payload.employment_type = storedEmploymentType(dto.employmentType);
    }
    if (dto.cibilBand !== undefined) payload.cibil_band = storedCibilBand(dto.cibilBand);
    if (dto.hasExistingEmi !== undefined) payload.has_existing_emi = dto.hasExistingEmi === true;
    if (dto.totalMonthlyEmi !== undefined || dto.hasExistingEmi === false) {
      payload.total_monthly_emi =
        dto.hasExistingEmi === false ? 0 : dto.totalMonthlyEmi ?? null;
    }
    if (dto.cibilReportName !== undefined) {
      payload.cibil_report_name = dto.cibilReportName?.trim() || null;
    }
    const hasPartner = Boolean(String(payload.agent_id ?? existing.agent_id ?? '').trim());
    const approved = isApprovedLeadStatus(payload.status ?? existing.status);
    if (!hasPartner) {
      payload.commission_type = null;
      payload.commission_value = null;
    } else if (dto.commissionType !== undefined || dto.commissionValue !== undefined) {
      if (!approved) {
        payload.commission_type = null;
        payload.commission_value = null;
      } else {
        const category = normalizeStoredCategory(
          String(payload.category ?? existing.category ?? ''),
        );
        const loanAmount =
          category === 'insurance'
            ? 0
            : leadLoanAmount({
                required_amount: payload.required_amount ?? existing.required_amount,
                loan_amt: payload.loan_amt ?? existing.loan_amt,
              });
        const commissionError = commissionInputError({
          category,
          loanAmount,
          type: dto.commissionType,
          value: dto.commissionValue,
        });
        if (commissionError) throw new LeadRuleError(commissionError, 'COMMISSION_INVALID');
        payload.commission_type = dto.commissionType;
        payload.commission_value = dto.commissionValue ?? null;
      }
    }
    if (dto.agentId) payload.agent_id = dto.agentId.trim();
    if (dto.otpVerified === true) payload.otp_verified = true;
    if (dto.consentAccepted === true) payload.consent_accepted = true;

    const nextStatus = String(payload.status ?? existing.status ?? '').trim();
    const nextAgent = String(payload.agent_id ?? existing.agent_id ?? '').trim();
    const nextCategory = normalizeStoredCategory(
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
      isApprovedLeadStatus(nextStatus) &&
      !isApprovedLeadStatus(existing.status) &&
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
        const category = normalizeStoredCategory(
          dto.category ??
            (payload.category as string | undefined) ??
            String(existing['category'] ?? ''),
        );
        const ins = normalizeStoredInsType(
          category,
          dto.insType ??
            (payload.ins_type as string | undefined) ??
            String(existing['ins_type'] ?? ''),
        );
        const other = await this.findBlockingSameCategoryLead(
          String(existing['mobile_number'] ?? ''),
          panUpper,
          category,
          ins,
          id,
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

    const from = fromStatus.trim().toLowerCase();
    const to = toStatus.trim().toLowerCase();
    const mobile = String((data as Record<string, unknown>).mobile_number ?? existing.mobile_number ?? '');
    const fullName = String((data as Record<string, unknown>).full_name ?? existing.full_name ?? '');
    if (to === 'in_process' && from !== 'in_process') {
      this.whatsapp.notifyUnderReview(mobile, fullName);
    }
    if (to === 'rejected' && from !== 'rejected') {
      this.whatsapp.notifyRejected(mobile, fullName);
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
    if (isDraftLead(row)) {
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
    if (!existing) return false;
    const leadId = id.trim();
    const mobile = String(existing.mobile_number ?? '').trim();
    const panHash = String(existing.pan_hash ?? '').trim();

    await this.deletePanAuditForLead(leadId);

    const { data, error } = await this.leads.delete().eq('id', leadId).select('id');

    if (error) {
      console.error('LeadsService.deleteById', error.message);
      return false;
    }

    const ok = Array.isArray(data) && data.length > 0;
    if (!ok) return false;

    await this.purgeClientSideData(mobile, panHash);

    if (isApprovedLeadStatus(existing.status)) {
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
    return true;
  }

  private async deletePanAuditForLead(leadId: string): Promise<void> {
    const { error } = await this.supabase.from(TABLE_PAN_ACCESS_AUDIT).delete().eq('lead_id', leadId);
    if (error) console.error('LeadsService.deletePanAuditForLead', error.message);
  }

  /**
   * After a lead row is gone: OTP sessions always, PAN slots if unused / last lead.
   * Never deletes wp_enquiries — that is WhatsApp inbox delete only.
   */
  private async purgeClientSideData(mobile: string, panHash: string): Promise<void> {
    if (!/^[6-9]\d{9}$/.test(mobile)) return;
    await this.otpService.deleteSessionsForMobile(mobile);

    const { count, error } = await this.leads
      .select('id', { count: 'exact', head: true })
      .eq('mobile_number', mobile);
    if (error) {
      console.error('LeadsService.purgeClientSideData count', error.message);
      return;
    }
    if ((count ?? 0) === 0) {
      const { error: slotErr } = await this.supabase
        .from(TABLE_LEAD_MOBILE_PAN_SLOTS)
        .delete()
        .eq('mobile_number', mobile);
      if (slotErr) console.error('LeadsService.purgeClientSideData slots', slotErr.message);
      return;
    }
    if (!panHash) return;
    const { data: still, error: stillErr } = await this.leads
      .select('id')
      .eq('mobile_number', mobile)
      .eq('pan_hash', panHash)
      .limit(1);
    if (stillErr) {
      console.error('LeadsService.purgeClientSideData pan', stillErr.message);
      return;
    }
    if (Array.isArray(still) && still.length > 0) return;
    const { error: dropErr } = await this.supabase
      .from(TABLE_LEAD_MOBILE_PAN_SLOTS)
      .delete()
      .eq('mobile_number', mobile)
      .eq('pan_hash', panHash);
    if (dropErr) console.error('LeadsService.purgeClientSideData drop slot', dropErr.message);
  }
}
