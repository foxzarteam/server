import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Put, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { AdminCrmGuard } from '../common/admin-crm.guard';
import { UpdateWhatsappSettingsDto } from './whatsapp.dto';
import { WhatsappService } from './whatsapp.service';
import { WhatsappSettingsService } from './whatsapp-settings.service';
import { whatsappHubChallenge } from './whatsapp-verify';

function webhookRawBody(req: RawBodyRequest<Request>): Buffer {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (Buffer.isBuffer(req.body)) return req.body;
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
    return { success: true, data: this.settings.toPublic(stored) };
  }

  @Put('admin/settings')
  @UseGuards(AdminCrmGuard)
  @HttpCode(HttpStatus.OK)
  async updateAdminSettings(@Body() dto: UpdateWhatsappSettingsDto) {
    const saved = await this.settings.update(dto);
    this.whatsapp.clearLinkCache();
    return {
      success: true,
      data: this.settings.toPublic(saved.settings),
      ...(saved.warning ? { warning: saved.warning } : {}),
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

  @Post('admin/enquiries/:id/reply')
  @UseGuards(AdminCrmGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 16 * 1024 * 1024 } }))
  @HttpCode(HttpStatus.OK)
  async adminReply(
    @Param('id') id: string,
    @Body() body: { text?: string },
    @UploadedFile() file?: { buffer: Buffer; originalname: string; mimetype: string; size: number },
  ) {
    const result = await this.whatsapp.adminReply(id, String(body?.text ?? ''), file);
    if (!result.ok) throw new BadRequestException(result.error || 'Could not send.');
    return { success: true, data: result.data };
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
}
