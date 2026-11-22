import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { toPublicErrorMessage } from './public-error';

const GENERIC = 'Something went wrong. Please try again.';

@Catch()
export class PublicExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PublicExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<{ originalUrl?: string; url?: string }>();
    const parsed = this.parse(exception);
    const path = String(req?.originalUrl || req?.url || '').split('?')[0];
    const passRaw = /\/partners\/admin(\/image)?(\/[^/]+)?\/?$/.test(path);

    if (parsed.status >= 500 || passRaw) {
      this.logger.error(
        parsed.raw || 'Unhandled exception',
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    const message = passRaw
      ? (parsed.raw || GENERIC).slice(0, 800)
      : toPublicErrorMessage(
          parsed.status >= HttpStatus.INTERNAL_SERVER_ERROR ? '' : parsed.raw,
          GENERIC,
        );

    res.status(parsed.status).json({
      success: false,
      statusCode: parsed.status,
      message,
      ...(parsed.code ? { code: parsed.code } : {}),
      ...(parsed.leadStatusSaved != null
        ? { leadStatusSaved: parsed.leadStatusSaved }
        : {}),
    });
  }

  private parse(exception: unknown): {
    status: number;
    raw: string;
    code?: string;
    leadStatusSaved?: boolean;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        return { status, raw: body };
      }
      if (body && typeof body === 'object') {
        const o = body as Record<string, unknown>;
        const raw = this.messageFrom(o.message) || String(o.error ?? exception.message ?? '');
        const code = typeof o.code === 'string' && o.code.trim() ? o.code.trim() : undefined;
        const leadStatusSaved =
          typeof o.leadStatusSaved === 'boolean' ? o.leadStatusSaved : undefined;
        return { status, raw, code, leadStatusSaved };
      }
      return { status, raw: exception.message };
    }

    if (exception instanceof Error) {
      return { status: HttpStatus.INTERNAL_SERVER_ERROR, raw: exception.message };
    }
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, raw: '' };
  }

  private messageFrom(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) {
      return value.map((x) => String(x ?? '').trim()).filter(Boolean).join('. ');
    }
    return '';
  }
}
