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
  isPanelActor,
  verifyAdminActor,
  type AdminActor,
} from './admin-actor';

type ActorRequest = {
  headers?: Record<string, string | string[] | undefined>;
  adminActor?: AdminActor;
  params?: { userId?: string };
};

function headerValue(
  headers: ActorRequest['headers'],
  names: string[],
): string | undefined {
  for (const name of names) {
    const raw = headers?.[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

export function readInternalKey(headers: ActorRequest['headers']): string | undefined {
  return headerValue(headers, ['x-admin-internal-key', 'X-Admin-Internal-Key']);
}

/** BFF key + signed actor. Identity comes from the token, never the body. */
export function bindSignedActor(
  req: ActorRequest,
  allow: (actor: AdminActor | null) => boolean,
): boolean {
  if (!adminInternalKeyOk(readInternalKey(req.headers))) {
    throw new UnauthorizedException('Unauthorized');
  }
  const actor = verifyAdminActor(extractAdminActorToken(req.headers ?? {}));
  if (!allow(actor) || !actor) {
    throw new UnauthorizedException('Unauthorized');
  }
  req.adminActor = actor;
  return true;
}

/** Server-to-server routes that only the website BFF should call. */
@Injectable()
export class InternalKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ActorRequest>();
    if (!adminInternalKeyOk(readInternalKey(req.headers))) {
      throw new UnauthorizedException('Unauthorized');
    }
    return true;
  }
}

/**
 * CRM admin routes: requires BFF internal key AND a short-lived signed actor token.
 * Role/identity come from the actor — never from the request body.
 */
@Injectable()
export class AdminCrmGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ActorRequest>();
    return bindSignedActor(req, isCrmAdminActor);
  }
}

/** Admin/staff/agent panel — for partner-safe actions (e.g. create lead). */
@Injectable()
export class AdminPanelGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ActorRequest>();
    return bindSignedActor(req, isPanelActor);
  }
}

/** Admin-only (not staff) for destructive / high-risk CRM actions. */
@Injectable()
export class AdminOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ActorRequest>();
    if (String(req.adminActor?.role ?? '').toLowerCase() !== 'admin') {
      throw new UnauthorizedException('Admin role required');
    }
    return true;
  }
}

/**
 * Partner wallet read. Admin/staff may read any partner.
 * An agent may read only their own wallet.
 */
@Injectable()
export class WalletReadGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ActorRequest>();
    bindSignedActor(req, isPanelActor);
    const userId = String(req.params?.userId ?? '').trim();
    const actor = req.adminActor;
    if (actor && (isCrmAdminActor(actor) || actor.sub === userId)) return true;
    throw new UnauthorizedException('Unauthorized');
  }
}
