import { Body, Controller, Delete, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AdminCrmGuard } from '../common/admin-crm.guard';
import { UpdateWhatsappSettingsDto } from './whatsapp.dto';
import { WhatsappService, defaultGeminiModel } from './whatsapp.service';
import { WhatsappSettings, WhatsappSettingsService } from './whatsapp-settings.service';
import { whatsappHubChallenge } from './whatsapp-verify';

function webhookRawBody(req: RawBodyRequest<Request>): Buffer {
  if (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 0) return req.rawBody;
  if (Buffer.isBuffer(req.body) && req.body.length > 0) return req.body;
  if (req.body && typeof req.body === 'object') {
    try {
      return Buffer.from(JSON.stringify(req.body));
    } catch {
      return Buffer.from('');
    }
  }
  return Buffer.from('');
}

@Controller('whatsapp')
export class WhatsappController {
  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly settings: WhatsappSettingsService,
  ) {}

  /** Public website button. Returns only the wa.me link, never credentials. */
  @Get('link')
  @HttpCode(HttpStatus.OK)
  async link() {
    const url = await this.whatsapp.publicLink();
    return { success: true, url };
  }

  @Get('admin/settings')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async adminSettings() {
    const stored = await this.settings.getStored();
    return { success: true, data: await this.presentSettings(stored) };
  }

  @Put('admin/settings')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async updateAdminSettings(@Body() dto: UpdateWhatsappSettingsDto) {
    const saved = await this.settings.update(dto);
    this.whatsapp.clearLinkCache();
    let settings = saved.settings;
    let modelWarning = '';
    if (settings.geminiApiKey) {
      const resolved = await this.whatsapp.resolveGeminiModel(settings.geminiApiKey, settings.geminiModel);
      if (resolved.model && resolved.model !== settings.geminiModel) {
        settings = await this.settings.setGeminiModel(resolved.model);
      }
      modelWarning = resolved.error || '';
    }
    const warning = [saved.warning, modelWarning].filter(Boolean).join(' ');
    return {
      success: true,
      data: await this.presentSettings(settings),
      ...(warning ? { warning } : {}),
    };
  }

  @Get('admin/enquiries')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async adminEnquiries() {
    const data = await this.whatsapp.listForAdmin();
    return { success: true, data };
  }

  @Get('admin/enquiries/:id')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async adminEnquiry(@Param('id') id: string) {
    const data = await this.whatsapp.getForAdmin(id);
    if (!data) throw new NotFoundException('Chat not found.');
    return { success: true, data };
  }

  @Delete('admin/enquiries/:id')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async deleteAdminEnquiry(@Param('id') id: string) {
    const ok = await this.whatsapp.deleteForAdmin(id);
    if (!ok) throw new NotFoundException('Chat not found.');
    return { success: true };
  }

  /** Meta subscription handshake — body must be the raw challenge, not JSON. */
  @Get('webhook')
  async verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() res: Response,
  ) {
    const settings = await this.settings.getEffective();
    const ok = whatsappHubChallenge({
      mode,
      token,
      challenge,
      expectedToken: settings.verifyToken,
    });
    if (ok == null) {
      return res.status(403).type('text/plain').send('Forbidden');
    }
    return res.status(200).type('text/plain').send(ok);
  }

  /** Inbound WhatsApp messages. Always 200 after a valid signature so Meta does not retry forever. */
  @Post('webhook')
  async receive(@Req() req: RawBodyRequest<Request>, @Res() res: Response) {
    const raw = webhookRawBody(req);
    const signature = req.header('x-hub-signature-256') ?? undefined;
    const result = await this.whatsapp.handleWebhook(raw, signature);
    if (result === 'forbidden') {
      return res.status(403).type('text/plain').send('Forbidden');
    }
    return res.status(200).type('text/plain').send('');
  }

  private async presentSettings(settings: WhatsappSettings) {
    const data = this.settings.toPublic(settings);
    const geminiModels = settings.geminiApiKey
      ? await this.whatsapp.listChatModels(settings.geminiApiKey)
      : [];
    return {
      ...data,
      geminiModels,
      geminiModel: data.geminiModel || defaultGeminiModel(geminiModels),
    };
  }
}
