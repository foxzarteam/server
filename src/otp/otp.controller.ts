import { Body, Controller, Get, Post, Res, HttpCode, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { OtpService } from './otp.service';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';

@Controller('otp')
export class OtpController {
  constructor(
    private readonly otpService: OtpService,
    private readonly config: ConfigService,
  ) {}

  @Post('send')
  @HttpCode(HttpStatus.OK)
  async send(@Body() dto: SendOtpDto) {
    return this.otpService.send(dto);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verify(@Body() dto: VerifyOtpDto) {
    return this.otpService.verify(dto);
  }

  @Get('live')
  live() {
    const raw = (this.config.get<string>('LIVE') ?? '').toLowerCase().trim();
    const live = raw === 'true' || raw === '1';
    return { live };
  }

  @Get('dev')
  dev(@Res() res: Response) {
    const isProduction = this.config.get<string>('NODE_ENV') === 'production';
    const allowOtpDev = this.config.get<string>('ALLOW_OTP_DEV') === 'true';
    const rawLive = (this.config.get<string>('LIVE') ?? '').toLowerCase().trim();
    const live = rawLive === 'true' || rawLive === '1';
    if (isProduction && !allowOtpDev) {
      return res.status(404).json({ error: 'Not found' });
    }

    // Serverless-safe: read from DB instead of relying on in-memory devOtps.
    this.otpService.getLatestOtpSessions(10).then((entries) => {
      const rows = live
        ? ''
        : entries
            .map(
              (e) =>
                `<tr><td>${this.escapeHtml(e.mobile_number)}</td><td><strong>${e.otp_code}</strong></td><td>${this.escapeHtml(
                  e.created_at,
                )}</td></tr>`,
            )
            .join('');

      const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>OTP Dev</title>
<style>body{font-family:system-ui;max-width:600px;margin:2rem auto;padding:1rem}table{width:100%;border-collapse:collapse}th,td{padding:0.5rem;text-align:left;border-bottom:1px solid #ddd}th{background:#333;color:#fff}</style>
</head>
<body>
<h1>OTP Dev Logs</h1>
<p><strong>LIVE:</strong> ${live ? 'true' : 'false'}</p>
<table>
<thead><tr><th>Mobile</th><th>OTP</th><th>Time</th></tr></thead>
<tbody>${
        rows ||
        (live
          ? '<tr><td colspan="3">LIVE=true. Firebase Phone Auth is active, so /api/otp/send is not used.</td></tr>'
          : '<tr><td colspan="3">No OTPs yet. Send one via POST /api/otp/send</td></tr>')
      }</tbody>
</table>
</body>
</html>`;

      res.type('text/html').send(html);
    }).catch(() => {
      res.type('text/html').send(
        `<!DOCTYPE html><html><body><h1>OTP Dev Logs</h1><p>Error fetching OTP logs.</p></body></html>`,
      );
    });
  }

  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }
}
