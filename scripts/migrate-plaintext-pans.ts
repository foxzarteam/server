/**
 * One-time helper: encrypt legacy plaintext PANs already in `leads.pan`.
 *
 * Usage (from server/ with env loaded):
 *   npx ts-node -r tsconfig-paths/register scripts/migrate-plaintext-pans.ts
 *
 * Safe to re-run: skips rows that already have pan_encrypted or masked pan.
 */
import { createClient } from '@supabase/supabase-js';
import {
  isMaskedPan,
  isValidPanFormat,
  normalizePan,
  panStorageFields,
} from '../src/security/pan-crypto';

async function main() {
  const url = process.env.SUPABASE_URL?.trim();
  const key =
    process.env.SUPABASE_SERVICE_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY required');
  }

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await sb.from('leads').select('id, pan, pan_encrypted');
  if (error) throw error;

  let migrated = 0;
  let skipped = 0;

  for (const row of data ?? []) {
    if (row.pan_encrypted) {
      skipped += 1;
      continue;
    }
    const pan = normalizePan(String(row.pan ?? ''));
    if (!isValidPanFormat(pan) || isMaskedPan(pan)) {
      skipped += 1;
      continue;
    }
    const fields = panStorageFields(pan);
    const { error: upErr } = await sb.from('leads').update(fields).eq('id', row.id);
    if (upErr) {
      console.error('Failed', row.id, upErr.message);
      continue;
    }
    migrated += 1;
    console.log('Migrated lead', row.id, '→', fields.pan);
  }

  console.log(`Done. migrated=${migrated} skipped=${skipped}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
