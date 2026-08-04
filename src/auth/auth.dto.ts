import { IsEmail, IsString, MinLength } from 'class-validator';

export const AUTH_FAIL = 'Invalid email or password';

export class AdminLoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(1, { message: 'Password is required' })
  password: string;
}

export type AuthUserPublic = {
  id: string;
  email: string;
  role: string;
  full_name: string;
};

export type AuthRow = {
  id: string;
  full_name: string;
  email: string;
  password: string;
  role: string;
};

/** Real bcrypt hashes are ~60 chars and match this prefix; avoids treating odd strings as bcrypt. */
export function storedPasswordLooksBcrypt(stored: string): boolean {
  const s = stored.trim();
  return s.length >= 59 && /^\$2[aby]\$\d{2}\$/.test(s);
}

export function normalizeStoredCredential(raw: string): string {
  let v = raw.replace(/^\uFEFF/, '').trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}
