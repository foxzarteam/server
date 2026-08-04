import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { adminInternalKeyOk } from './admin-internal';

/** Requires valid `x-admin-internal-key` header (BFF / admin CRM). */
@Injectable()
export class AdminInternalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
    }>();
    const raw =
      req.headers?.['x-admin-internal-key'] ??
      req.headers?.['X-Admin-Internal-Key'];
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!adminInternalKeyOk(key)) {
      throw new UnauthorizedException('Unauthorized');
    }
    return true;
  }
}
