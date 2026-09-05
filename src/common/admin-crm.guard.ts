import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { adminInternalKeyOk } from './admin-internal';
import {
  extractAdminActorToken,
  isCrmAdminActor,
  verifyAdminActor,
  type AdminActor,
} from './admin-actor';

/**
 * CRM admin routes: requires BFF internal key AND a short-lived signed actor token.
 * Role/identity come from the actor — never from the request body.
 */
@Injectable()
export class AdminCrmGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
      adminActor?: AdminActor;
    }>();
    const rawKey =
      req.headers?.['x-admin-internal-key'] ??
      req.headers?.['X-Admin-Internal-Key'];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (!adminInternalKeyOk(key)) {
      throw new UnauthorizedException('Unauthorized');
    }

    const actor = verifyAdminActor(extractAdminActorToken(req.headers ?? {}));
    if (!isCrmAdminActor(actor) || !actor) {
      throw new UnauthorizedException('Unauthorized');
    }

    req.adminActor = actor;
    return true;
  }
}

/** Admin-only (not staff) for destructive / high-risk CRM actions. */
@Injectable()
export class AdminOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ adminActor?: AdminActor }>();
    const role = String(req.adminActor?.role ?? '').toLowerCase();
    if (role !== 'admin') {
      throw new UnauthorizedException('Admin role required');
    }
    return true;
  }
}
