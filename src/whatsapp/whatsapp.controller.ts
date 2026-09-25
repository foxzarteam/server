import { Controller, Get, Post, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { whatsappHubChallenge } from './whatsapp-verify';

@Controller('whatsapp')
export class WhatsappController {
  constructor(private readonly config: ConfigService) {}

  private expectedToken(): string {
    return (this.config.get<string>('WHATSAPP_VERIFY_TOKEN') ?? '').trim();
  }

  /** Meta subscription handshake — body must be the raw challenge, not JSON. */
  @Get('webhook')
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() res: Response,
  ) {
    const ok = whatsappHubChallenge({
      mode,
      token,
      challenge,
      expectedToken: this.expectedToken(),
    });
    if (ok == null) {
      return res.status(403).type('text/plain').send('Forbidden');
    }
    return res.status(200).type('text/plain').send(ok);
  }

  /**
   * Inbound events (messages, statuses). Handshake only for now — always 200
   * so Meta keeps the subscription. Processing comes later.
   */
  @Post('webhook')
  receive(@Res() res: Response) {
    return res.status(200).type('text/plain').send('');
  }
}
