import type { NextFunction, Request, Response } from 'express';
import express from 'express';

type RawReq = Request & { rawBody?: Buffer };

function isWebhookPost(req: Request): boolean {
  if (req.method !== 'POST') return false;
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  return /\/whatsapp\/webhook\/?$/.test(path);
}

/** Keep Meta's exact bytes so X-Hub-Signature-256 matches. JSON parsing would break inbound. */
export function captureWhatsappWebhookRawBody(req: Request, res: Response, next: NextFunction): void {
  if (!isWebhookPost(req)) {
    next();
    return;
  }
  const already = (req as RawReq).rawBody;
  if (Buffer.isBuffer(already) && already.length) {
    next();
    return;
  }
  express.raw({ type: () => true, limit: '2mb' })(req, res, (err) => {
    if (!err && Buffer.isBuffer(req.body)) {
      (req as RawReq).rawBody = req.body;
    }
    next(err);
  });
}
