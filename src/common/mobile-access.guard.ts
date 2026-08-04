import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { OtpService } from '../otp/otp.service';
import { assertMobileAccess, extractIdToken } from './phone-access';

/**
 * Allows access with admin internal key, Firebase idToken, or recent OTP verification.
 * Mobile is resolved from params, body, or query (mobileNumber / mobile).
 */
@Injectable()
export class MobileAccessGuard implements CanActivate {
  constructor(private readonly otpService: OtpService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
      params?: Record<string, string>;
      body?: Record<string, unknown>;
      query?: Record<string, string | string[] | undefined>;
    }>();

    const headers = req.headers ?? {};
    const rawAdmin =
      headers['x-admin-internal-key'] ?? headers['X-Admin-Internal-Key'];
    const adminKey = Array.isArray(rawAdmin) ? rawAdmin[0] : rawAdmin;

    const mobile = this.resolveMobile(req);
    if (!mobile) {
      throw new UnauthorizedException('Unauthorized');
    }

    await assertMobileAccess(this.otpService, mobile, {
      adminKey,
      idToken: extractIdToken(headers, req.body?.idToken),
    });
    return true;
  }

  private resolveMobile(req: {
    params?: Record<string, string>;
    body?: Record<string, unknown>;
    query?: Record<string, string | string[] | undefined>;
  }): string | null {
    const candidates: unknown[] = [
      req.params?.mobileNumber,
      req.params?.mobile,
      req.body?.mobileNumber,
      req.body?.mobile,
      req.query?.mobileNumber,
      req.query?.mobile,
    ];
    for (const c of candidates) {
      const v = Array.isArray(c) ? c[0] : c;
      if (typeof v === 'string' && /^[6-9]\d{9}$/.test(v.trim())) {
        return v.trim();
      }
    }
    return null;
  }
}
