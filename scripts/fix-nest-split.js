/**
 * Post-split fix: export shared helpers/types, fix imports, missing decorators.
 */
const fs = require("fs");
const path = require("path");
const SRC = path.join(__dirname, "..", "src");

function write(p, c) {
  fs.writeFileSync(p, c.endsWith("\n") ? c : c + "\n");
}
function read(p) {
  return fs.readFileSync(p, "utf8");
}

// ---- OTP ----
{
  write(
    path.join(SRC, "otp/otp.dto.ts"),
    `import { IsString, Length, Matches, MinLength } from 'class-validator';

export class SendOtpDto {
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;
}

export class VerifyFirebaseOtpDto {
  @IsString()
  @Length(10, 10, { message: 'mobileNumber must be 10 digits' })
  @Matches(/^[6-9]\\d{9}$/, { message: 'Invalid Indian mobile number' })
  mobileNumber: string;

  @IsString()
  @MinLength(20, { message: 'idToken is required' })
  idToken: string;
}

export type OtpResult = {
  success: boolean;
  message: string;
  remainingSends?: number;
  /** True when daily limit hit — allow again next calendar day (IST). */
  retryNextDay?: boolean;
};
`,
  );

  let svc = read(path.join(SRC, "otp/otp.service.ts"));
  svc = svc
    .replace(
      /import \{\s*Body,[\s\S]*?\} from '@nestjs\/common';/,
      `import { HttpCode, HttpStatus, Inject, Injectable } from '@nestjs/common';`,
    )
    .replace(/import \{ Response \} from 'express';\n/, "")
    .replace(/import \{ IsString[\s\S]*?\} from 'class-validator';\n/, "")
    .replace(/import \{ OtpService \} from '\.\.\/otp\/otp\.service';\n/, "")
    .replace(
      /import \{\s*SendOtpDto,\s*VerifyFirebaseOtpDto,\s*\} from '\.\/otp\.dto';/,
      `import type { OtpResult } from './otp.dto';`,
    );
  // remove unused HttpCode if any - keep Inject Injectable
  svc = svc.replace(
    /import \{ HttpCode, HttpStatus, Inject, Injectable \} from '@nestjs\/common';/,
    `import { Inject, Injectable } from '@nestjs/common';`,
  );
  write(path.join(SRC, "otp/otp.service.ts"), svc);

  let ctrl = read(path.join(SRC, "otp/otp.controller.ts"));
  ctrl = ctrl
    .replace(/import \{ OtpService \} from '\.\.\/otp\/otp\.service';\n/g, "")
    .replace(
      /import \{\s*SendOtpDto,\s*VerifyFirebaseOtpDto,\s*\} from '\.\/otp\.dto';\nimport \{ OtpService \} from '\.\/otp\.service';/,
      `import { SendOtpDto, VerifyFirebaseOtpDto } from './otp.dto';\nimport { OtpService } from './otp.service';`,
    );
  // fix if double OtpService
  const otcLines = ctrl.split("\n");
  const seen = new Set();
  const filtered = otcLines.filter((l) => {
    if (l.includes("OtpService") && l.includes("import")) {
      if (seen.has("OtpService")) return false;
      seen.add("OtpService");
    }
    return true;
  });
  // ensure one otp.service import
  if (![...filtered].some((l) => l.includes("from './otp.service'"))) {
    filtered.splice(1, 0, "import { OtpService } from './otp.service';");
  }
  write(path.join(SRC, "otp/otp.controller.ts"), filtered.join("\n"));
}

// ---- users ----
{
  let dto = read(path.join(SRC, "users/users.dto.ts"));
  dto = dto
    .replace(
      /const MPIN_LENGTH = 4;\nconst DEFAULT_USER_NAME = 'User';/,
      `export const MPIN_LENGTH = 4;\nexport const DEFAULT_USER_NAME = 'User';`,
    )
    .replace(/,\s*Min,\s*/g, ",\n  ")
    .replace(/Min,\n/, "");
  // remove unused Min from import
  dto = dto.replace(/\n\s*Min,?\n/, "\n");
  write(path.join(SRC, "users/users.dto.ts"), dto);

  let svc = read(path.join(SRC, "users/users.service.ts"));
  if (!svc.includes("DEFAULT_USER_NAME")) {
    svc = svc.replace(
      /from '\.\/users\.dto';/,
      `from './users.dto';\nimport { DEFAULT_USER_NAME, MPIN_LENGTH } from './users.dto';`,
    );
  } else {
    svc = svc.replace(
      /import \{([\s\S]*?)\} from '\.\/users\.dto';/,
      (m, inner) => {
        if (inner.includes("DEFAULT_USER_NAME")) return m;
        return `import {${inner},\n  DEFAULT_USER_NAME,\n  MPIN_LENGTH,\n} from './users.dto';`;
      },
    );
  }
  if (!/DEFAULT_USER_NAME/.test(svc.split("from './users.dto'")[0])) {
    // ensure import line has constants
    if (svc.includes("from './users.dto'")) {
      svc = svc.replace(
        /import \{([\s\S]*?)\} from '\.\/users\.dto';/,
        (m, inner) => {
          let i = inner;
          if (!i.includes("DEFAULT_USER_NAME")) i += ",\n  DEFAULT_USER_NAME";
          if (!i.includes("MPIN_LENGTH")) i += ",\n  MPIN_LENGTH";
          return `import {${i}\n} from './users.dto';`;
        },
      );
    }
  }
  svc = svc.replace(/import \{ OtpService \} from '\.\.\/otp\/otp\.service';\nimport \{ OtpService \}/g, "import { OtpService }");
  // clean Nest unused from service
  svc = svc
    .replace(/Body,\n\s*/g, "")
    .replace(/Controller,\n\s*/g, "")
    .replace(/Delete,\n\s*/g, "")
    .replace(/Get,\n\s*/g, "")
    .replace(/Headers,\n\s*/g, "")
    .replace(/HttpCode,\n\s*/g, "")
    .replace(/HttpStatus,\n\s*/g, "")
    .replace(/Param,\n\s*/g, "")
    .replace(/Patch,\n\s*/g, "")
    .replace(/Post,\n\s*/g, "")
    .replace(/Put,\n\s*/g, "")
    .replace(/UnauthorizedException,\n\s*/g, "")
    .replace(/NotFoundException,\n\s*/g, "");
  write(path.join(SRC, "users/users.service.ts"), svc);
}

// ---- auth ----
{
  let dto = read(path.join(SRC, "auth/auth.dto.ts"));
  dto = dto
    .replace(/const AUTH_FAIL/, "export const AUTH_FAIL")
    .replace(/type AuthRow/, "export type AuthRow")
    .replace(/export type AuthUserPublic/, "export type AuthUserPublic")
    .replace(/function storedPasswordLooksBcrypt/, "export function storedPasswordLooksBcrypt")
    .replace(/function normalizeStoredCredential/, "export function normalizeStoredCredential")
    .replace(/Length,\n\s*/g, "")
    .replace(/Min,\n\s*/g, "");
  write(path.join(SRC, "auth/auth.dto.ts"), dto);

  let svc = read(path.join(SRC, "auth/auth.service.ts"));
  if (!svc.includes("AUTH_FAIL")) {
    svc = svc.replace(
      /from '\.\/auth\.dto';/,
      `from './auth.dto';\nimport {\n  AUTH_FAIL,\n  AuthRow,\n  AuthUserPublic,\n  normalizeStoredCredential,\n  storedPasswordLooksBcrypt,\n} from './auth.dto';`,
    );
  }
  // dedupe AdminLoginDto import with helpers
  if ((svc.match(/from '\.\/auth\.dto'/g) || []).length > 1) {
    svc = svc.replace(
      /import \{\s*AdminLoginDto\s*\} from '\.\/auth\.dto';\nimport \{\s*AUTH_FAIL[\s\S]*?\} from '\.\/auth\.dto';/,
      `import {\n  AdminLoginDto,\n  AUTH_FAIL,\n  AuthRow,\n  AuthUserPublic,\n  normalizeStoredCredential,\n  storedPasswordLooksBcrypt,\n} from './auth.dto';`,
    );
  }
  write(path.join(SRC, "auth/auth.service.ts"), svc);
}

// ---- banners ----
{
  write(
    path.join(SRC, "banners/banners.types.ts"),
    `export type BannerPublic = {
  id: string;
  imageUrl: string;
  title?: string;
  description?: string;
  category: string;
  displayOrder: number;
  actionUrl?: string;
  actionType?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};
`,
  );
  let svc = read(path.join(SRC, "banners/banners.service.ts"));
  svc = svc
    .replace(
      /import \{ Controller, Get, HttpCode, HttpStatus, Inject, Injectable, Param \} from '@nestjs\/common';/,
      `import { Inject, Injectable } from '@nestjs/common';`,
    )
    .replace(
      /from '\.\.\/common\/constants';/,
      `from '../common/constants';\nimport type { BannerPublic } from './banners.types';`,
    );
  write(path.join(SRC, "banners/banners.service.ts"), svc);

  let ctrl = read(path.join(SRC, "banners/banners.controller.ts"));
  if (!ctrl.includes("from '@nestjs/common'")) {
    ctrl =
      `import { Controller, Get, HttpCode, HttpStatus, Param } from '@nestjs/common';\n` +
      ctrl;
  }
  write(path.join(SRC, "banners/banners.controller.ts"), ctrl);
}

// ---- admin ----
{
  write(
    path.join(SRC, "admin/admin.types.ts"),
    `export type DashboardStats = {
  totalLeads: number;
  totalAgents: number;
  totalPartners: number;
};
`,
  );
  let svc = read(path.join(SRC, "admin/admin.service.ts"));
  svc = svc
    .replace(
      /import \{\s*Controller[\s\S]*?\} from '@nestjs\/common';/,
      `import { Inject, Injectable } from '@nestjs/common';`,
    )
    .replace(/import \{ adminInternalKeyOk \} from '\.\.\/common\/admin-internal';\n/, "")
    .replace(
      /from '\.\.\/config\/supabase';/,
      `from '../config/supabase';\nimport type { DashboardStats } from './admin.types';`,
    );
  write(path.join(SRC, "admin/admin.service.ts"), svc);

  let ctrl = read(path.join(SRC, "admin/admin.controller.ts"));
  if (!ctrl.includes("@nestjs/common")) {
    ctrl =
      `import {\n  Controller,\n  Get,\n  Headers,\n  HttpCode,\n  HttpStatus,\n  UnauthorizedException,\n} from '@nestjs/common';\nimport { adminInternalKeyOk } from '../common/admin-internal';\n` +
      ctrl;
  }
  write(path.join(SRC, "admin/admin.controller.ts"), ctrl);
}

// ---- services ----
{
  let dto = read(path.join(SRC, "services/services.dto.ts"));
  dto = dto
    .replace(/type ServicePublic/, "export type ServicePublic")
    .replace(
      /import \{([^}]+)\} from 'class-validator';/,
      (m, inner) => {
        let i = inner;
        if (!i.includes("IsInt")) i += ",\n  IsInt";
        return `import {${i}} from 'class-validator';`;
      },
    );
  // clean unused
  dto = dto.replace(/\n\s*Length,?\n/, "\n").replace(/\n\s*IsIn,?\n/, "\n");
  write(path.join(SRC, "services/services.dto.ts"), dto);

  let svc = read(path.join(SRC, "services/services.service.ts"));
  if (!svc.includes("ServicePublic")) {
    svc = svc.replace(
      /from '\.\/services\.dto';/,
      `from './services.dto';\nimport type { ServicePublic } from './services.dto';`,
    );
  }
  if (!svc.includes("ServicePublic") || !/ServicePublic/.test(svc.match(/import[\s\S]{0,400}services\.dto/)?.[0] || "")) {
    svc = svc.replace(
      /import \{([\s\S]*?)\} from '\.\/services\.dto';/,
      (m, inner) => {
        if (inner.includes("ServicePublic")) return m;
        return `import type { ServicePublic } from './services.dto';\nimport {${inner}} from './services.dto';`;
      },
    );
  }
  if (!/from '\.\/services\.dto'/.test(svc)) {
    svc =
      `import type { ServicePublic } from './services.dto';\nimport { AdminUpdateServiceDto } from './services.dto';\n` +
      svc;
  } else if (!svc.includes("ServicePublic")) {
    svc = `import type { ServicePublic } from './services.dto';\n` + svc;
  }
  write(path.join(SRC, "services/services.service.ts"), svc);
}

// ---- chat ----
{
  let dto = read(path.join(SRC, "chat/chat.dto.ts"));
  dto = dto
    .replace(
      /import \{([^}]+)\} from 'class-validator';/,
      `import {\n  IsOptional,\n  IsString,\n  Length,\n  Matches,\n  MinLength,\n  IsIn,\n  IsObject,\n} from 'class-validator';`,
    )
    .replace(/const CHAT_STATUSES/, "export const CHAT_STATUSES")
    .replace(/type ChatAnswerItem/, "export type ChatAnswerItem")
    .replace(/type ChatAnswers/, "export type ChatAnswers")
    .replace(/function isAnswerItem/, "export function isAnswerItem")
    .replace(/function parseAnswers/, "export function parseAnswers");
  write(path.join(SRC, "chat/chat.dto.ts"), dto);

  let svc = read(path.join(SRC, "chat/chat.service.ts"));
  if (!svc.includes("parseAnswers")) {
    svc = svc.replace(
      /from '\.\/chat\.dto';/,
      `from './chat.dto';\nimport { CHAT_STATUSES, parseAnswers } from './chat.dto';`,
    );
  }
  if ((svc.match(/from '\.\/chat\.dto'/g) || []).length >= 1 && !svc.includes("parseAnswers")) {
    svc = `import { CHAT_STATUSES, parseAnswers } from './chat.dto';\n` + svc;
  }
  // merge imports
  if ((svc.match(/from '\.\/chat\.dto'/g) || []).length > 1) {
    svc = svc.replace(
      /import \{[\s\S]*?\} from '\.\/chat\.dto';\nimport \{ CHAT_STATUSES, parseAnswers \} from '\.\/chat\.dto';/,
      `import {\n  CreateChatDto,\n  UpdateChatDto,\n  CHAT_STATUSES,\n  parseAnswers,\n} from './chat.dto';`,
    );
  }
  write(path.join(SRC, "chat/chat.service.ts"), svc);

  let ctrl = read(path.join(SRC, "chat/chat.controller.ts"));
  if (!ctrl.includes("parseAnswers")) {
    ctrl = ctrl.replace(
      /from '\.\/chat\.dto';/,
      `from './chat.dto';\nimport { parseAnswers } from './chat.dto';`,
    );
  }
  if ((ctrl.match(/from '\.\/chat\.dto'/g) || []).length > 1) {
    ctrl = ctrl.replace(
      /import \{[\s\S]*?\} from '\.\/chat\.dto';\nimport \{ parseAnswers \} from '\.\/chat\.dto';/,
      `import {\n  CreateChatDto,\n  UpdateChatDto,\n  parseAnswers,\n} from './chat.dto';`,
    );
  }
  write(path.join(SRC, "chat/chat.controller.ts"), ctrl);
}

// ---- customer ----
{
  let dto = read(path.join(SRC, "customer/customer.dto.ts"));
  dto = dto
    .replace(/function asString/, "export function asString")
    .replace(/function asAmount/, "export function asAmount")
    .replace(/function asBool/, "export function asBool")
    .replace(/function applicationNumberFromId/, "export function applicationNumberFromId")
    .replace(/function sanitizeApplication/, "export function sanitizeApplication");
  write(path.join(SRC, "customer/customer.dto.ts"), dto);

  let svc = read(path.join(SRC, "customer/customer.service.ts"));
  const custImport = `import type { CustomerApplication, CustomerProfile } from './customer.dto';
import {
  asString,
  sanitizeApplication,
  CheckMobileDto,
  CustomerLoginDto,
  ApplicationsDto,
  UpdateProfileDto,
} from './customer.dto';`;
  if (!svc.includes("sanitizeApplication")) {
    svc = svc.replace(/import \{[\s\S]*?\} from '\.\/customer\.dto';/, custImport);
    if (!svc.includes("sanitizeApplication")) {
      svc = custImport + "\n" + svc;
    }
  }
  write(path.join(SRC, "customer/customer.service.ts"), svc);
}

// ---- payment-accounts ----
{
  let dto = read(path.join(SRC, "payment-accounts/payment-accounts.dto.ts"));
  dto = dto.replace(
    /from 'class-validator';/,
    (m) => m,
  );
  if (!dto.includes("MaxLength")) {
    dto = dto.replace(
      /import \{([^}]+)\} from 'class-validator';/,
      `import {\n  IsOptional,\n  IsString,\n  MinLength,\n  IsIn,\n  MaxLength,\n} from 'class-validator';`,
    );
  }
  write(path.join(SRC, "payment-accounts/payment-accounts.dto.ts"), dto);

  let ctrl = read(path.join(SRC, "payment-accounts/payment-accounts.controller.ts"));
  // dedupe UsersService imports
  const lines = ctrl.split("\n");
  let seenUsers = false;
  const out = lines.filter((l) => {
    if (l.includes("UsersService") && l.includes("import")) {
      if (seenUsers) return false;
      seenUsers = true;
      return true;
    }
    return true;
  });
  write(path.join(SRC, "payment-accounts/payment-accounts.controller.ts"), out.join("\n"));
}

// ---- wallet rebuild imports ----
{
  write(
    path.join(SRC, "wallet/wallet.service.ts"),
    `import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { TABLE_WALLET } from '../common/constants';
import { SUPABASE_CLIENT } from '../config/supabase';

@Injectable()
export class WalletService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  private get table() {
    return this.supabase.from(TABLE_WALLET);
  }

  async getByUserId(userId: string): Promise<Record<string, unknown> | null> {
    const uid = userId.trim();
    const { data, error } = await this.table
      .select('id, user_id, earning, redeem, balance, currency, created_at, updated_at')
      .eq('user_id', uid)
      .maybeSingle();

    if (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('WalletService.getByUserId', error);
      }
      return null;
    }
    return data as Record<string, unknown> | null;
  }
}
`,
  );

  write(
    path.join(SRC, "wallet/wallet.controller.ts"),
    `import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  UnauthorizedException,
} from '@nestjs/common';
import { adminInternalKeyOk } from '../common/admin-internal';
import { assertMobileAccess, extractIdToken } from '../common/phone-access';
import { OtpService } from '../otp/otp.service';
import { UsersService } from '../users/users.service';
import { WalletService } from './wallet.service';

@Controller('wallet')
export class WalletController {
  constructor(
    private readonly walletService: WalletService,
    private readonly usersService: UsersService,
    private readonly otpService: OtpService,
  ) {}

  @Get('user/:userId')
  @HttpCode(HttpStatus.OK)
  async getByUserId(
    @Param('userId') userId: string,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Headers('x-admin-internal-key') adminKey: string | undefined,
  ) {
    if (!adminInternalKeyOk(adminKey)) {
      const user = await this.usersService.getById(userId);
      const mobile = String(user?.mobile_number ?? '').trim();
      if (!mobile) throw new UnauthorizedException('Unauthorized');
      await assertMobileAccess(this.otpService, mobile, {
        adminKey,
        idToken: extractIdToken(headers),
      });
    }

    const row = await this.walletService.getByUserId(userId);
    if (!row) {
      throw new NotFoundException('Wallet not found');
    }
    return { success: true, data: row };
  }
}
`,
  );
}

// ---- fix phone-access import path ----
{
  let phone = read(path.join(SRC, "common/phone-access.ts"));
  phone = phone.replace(
    /from '\.\.\/otp\/otp\.module'/,
    "from '../otp/otp.service'",
  );
  write(path.join(SRC, "common/phone-access.ts"), phone);
}

// ---- fix other OtpService/UsersService imports from .module ----
function rewriteImportsInDir(dir) {
  const full = path.join(SRC, dir);
  if (!fs.existsSync(full)) return;
  for (const f of fs.readdirSync(full).filter((x) => x.endsWith(".ts"))) {
    let c = read(path.join(full, f));
    const orig = c;
    c = c
      .replace(
        /import \{ OtpModule, OtpService \} from '([^']+)';/g,
        "import { OtpModule } from '$1';\nimport { OtpService } from '../otp/otp.service';",
      )
      .replace(
        /import \{ OtpService \} from '(\.\.\/)?otp\/otp\.module'/g,
        "import { OtpService } from '../otp/otp.service'",
      )
      .replace(
        /import \{ UsersModule, UsersService \} from '([^']+)';/g,
        "import { UsersModule } from '$1';\nimport { UsersService } from '../users/users.service';",
      )
      .replace(
        /import \{ UsersService \} from '(\.\.\/)?users\/users\.module'/g,
        "import { UsersService } from '../users/users.service'",
      )
      .replace(
        /import \{ LeadsModule, LeadsService \} from '([^']+)';/g,
        "import { LeadsModule } from '$1';\nimport { LeadsService } from '../leads/leads.service';",
      )
      .replace(
        /import \{ LeadsService \} from '(\.\.\/)?leads\/leads\.module'/g,
        "import { LeadsService } from '../leads/leads.service'",
      )
      .replace(
        /import type \{ OtpService \} from '\.\.\/otp\/otp\.module'/g,
        "import type { OtpService } from '../otp/otp.service'",
      );
    // self service wrong path
    if (f.endsWith(".service.ts")) {
      c = c.replace(
        new RegExp(`import \\{ \\w+Service \\} from '\\.\\./${dir}/${dir}\\.service';\\n?`),
        "",
      );
    }
    if (c !== orig) write(path.join(full, f), c);
  }
}

for (const d of fs.readdirSync(SRC)) {
  if (fs.statSync(path.join(SRC, d)).isDirectory()) rewriteImportsInDir(d);
}
// phone-access already done
rewriteImportsInDir("common");

// fix mobile-access guard
{
  let g = read(path.join(SRC, "common/mobile-access.guard.ts"));
  g = g.replace(
    /from '\.\.\/otp\/otp\.module'/,
    "from '../otp/otp.service'",
  );
  write(path.join(SRC, "common/mobile-access.guard.ts"), g);
}

// leads still may import OtpService from module
{
  for (const f of ["leads.service.ts", "leads.controller.ts", "leads.module.ts"]) {
    const p = path.join(SRC, "leads", f);
    if (!fs.existsSync(p)) continue;
    let c = read(p);
    c = c
      .replace(
        /import \{ OtpService \} from '\.\.\/otp\/otp\.module'/g,
        "import { OtpService } from '../otp/otp.service'",
      )
      .replace(
        /import \{ UsersService \} from '\.\.\/users\/users\.module'/g,
        "import { UsersService } from '../users/users.service'",
      );
    write(p, c);
  }
}

console.log("fix pass done");
