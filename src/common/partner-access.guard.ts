import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { AdminActor } from './admin-actor';
import { extractPartnerToken, verifyPartnerActor } from './partner-session';

/**
 * Mobile partner (az_app): signed agent token, no ADMIN_INTERNAL_KEY.
 * Never accept this guard on admin CRM routes.
 */
@Injectable()
export class PartnerAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
      partnerActor?: AdminActor;
    }>();
    const actor = verifyPartnerActor(extractPartnerToken(req.headers ?? {}));
    if (!actor) {
      throw new UnauthorizedException('Unauthorized');
    }
    req.partnerActor = actor;
    return true;
  }
}
