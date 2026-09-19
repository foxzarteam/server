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
    const res = host.switchToHttp().getResponse<Response>();
    const parsed = this.parse(exception);

    if (parsed.status >= 500) {
      this.logger.error(
        parsed.raw || 'Unhandled exception',
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    const message = toPublicErrorMessage(
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
