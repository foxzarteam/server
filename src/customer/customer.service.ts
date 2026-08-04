import { Injectable } from '@nestjs/common';
import { LeadsService } from '../leads/leads.service';
import { OtpService } from '../otp/otp.service';
import { isMaskedPan, isValidPanFormat, maskPan, normalizePan } from '../security/pan-crypto';
import {
  asString,
  CustomerApplication,
  CustomerProfile,
  sanitizeApplication,
  UpdateProfileDto,
} from './customer.dto';

@Injectable()
export class CustomerService {
  constructor(
    private readonly leadsService: LeadsService,
    private readonly otpService: OtpService,
  ) {}

  async getApplications(mobileNumber: string): Promise<CustomerApplication[]> {
    // Skip per-row OTP lookup — dashboard only needs lead fields (faster login/load).
    const rows = await this.leadsService.listByMobile(mobileNumber.trim(), {
      includeOtpVerified: false,
    });
    return rows
      .filter((row) => !this.leadsService.isDraftLead(row))
      .map(sanitizeApplication)
      .filter((a): a is CustomerApplication => a != null);
  }

  async mobileHasApplication(mobileNumber: string): Promise<boolean> {
    const rows = await this.leadsService.listByMobile(mobileNumber.trim(), {
      includeOtpVerified: false,
    });
    return rows.some((row) => !this.leadsService.isDraftLead(row));
  }

  /** Profile is derived from the customer's leads (newest lead wins). */
  async getProfile(mobileNumber: string): Promise<CustomerProfile | null> {
    const mobile = mobileNumber.trim();
    if (!mobile) return null;

    const rows = (
      await this.leadsService.listByMobile(mobile, { includeOtpVerified: false })
    ).filter((row) => !this.leadsService.isDraftLead(row));

    if (rows.length === 0) {
      // Session can still be valid after soft-deleting all apps.
      return {
        name: 'Customer',
        mobile,
        email: null,
        pan: null,
        totalApplications: 0,
        memberSince: null,
      };
    }

    const latest = rows[0];
    const oldest = rows[rows.length - 1];

    return {
      name: asString(latest.full_name) || 'Customer',
      mobile,
      email: asString(latest.email) || null,
      pan: (() => {
        const raw = asString(latest.pan);
        if (!raw) return null;
        if (isMaskedPan(raw)) return normalizePan(raw);
        if (isValidPanFormat(raw)) return maskPan(raw);
        return maskPan(raw);
      })(),
      totalApplications: rows.length,
      memberSince: asString(oldest.created_at) || null,
    };
  }

  async updateProfile(
    mobileNumber: string,
    dto: { fullName: string; email?: string },
  ): Promise<{ ok: boolean; message?: string; profile?: CustomerProfile }> {
    const mobile = mobileNumber.trim();
    const apps = (
      await this.leadsService.listByMobile(mobile, { includeOtpVerified: false })
    ).filter((row) => !this.leadsService.isDraftLead(row));
    if (apps.length === 0) {
      // No active applications — keep session name only (cannot persist to leads).
      return {
        ok: true,
        profile: {
          name: dto.fullName.trim() || 'Customer',
          mobile,
          email: dto.email?.trim() || null,
          pan: null,
          totalApplications: 0,
          memberSince: null,
        },
      };
    }

    const updated = await this.leadsService.updateProfileByMobile(mobile, {
      fullName: dto.fullName,
      email: dto.email ?? null,
    });
    if (!updated) {
      return { ok: false, message: 'Failed to update profile' };
    }

    const profile = await this.getProfile(mobile);
    return { ok: true, profile: profile ?? undefined };
  }

  /** Soft-ownership check: only delete if lead belongs to this mobile. */
  async deleteOwnApplication(
    id: string,
    mobileNumber: string,
  ): Promise<{ ok: boolean; message?: string }> {
    const lead = await this.leadsService.getById(id.trim());
    if (!lead) {
      return { ok: false, message: 'Application not found' };
    }
    const leadMobile = asString(lead.mobile_number);
    if (leadMobile !== mobileNumber.trim()) {
      return { ok: false, message: 'Application not found' };
    }
    const ok = await this.leadsService.deleteById(id.trim());
    if (!ok) {
      return { ok: false, message: 'Failed to delete application' };
    }
    return { ok: true };
  }

  async login(
    mobileNumber: string,
    idToken: string,
  ): Promise<{
    ok: boolean;
    message?: string;
    customer?: { mobile: string; name: string };
    applications?: CustomerApplication[];
  }> {
    const mobile = mobileNumber.trim();

    // Verify Firebase token once, then mark OTP session + load apps in parallel.
    const tokenOk = await this.otpService.assertFirebaseIdToken(mobile, idToken);
    if (!tokenOk.success) {
      return {
        ok: false,
        message: tokenOk.message || 'OTP verification expired. Please verify again.',
      };
    }

    const [, applications] = await Promise.all([
      this.otpService.markPhoneVerified(mobile),
      this.getApplications(mobile),
    ]);

    if (applications.length === 0) {
      return {
        ok: false,
        message:
          'No application found for this number. Please fill the Personal Loan form first.',
      };
    }

    return {
      ok: true,
      customer: {
        mobile,
        name: applications[0]?.full_name || 'Customer',
      },
      applications,
    };
  }
}
