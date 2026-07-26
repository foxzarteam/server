/**
 * PAN crypto self-check. Run from server/:
 *   npx ts-node --transpile-only scripts/test-pan-crypto.ts
 */
import assert from 'assert';
import {
  decryptPan,
  encryptPan,
  hashPan,
  isMaskedPan,
  isValidPanFormat,
  maskPan,
  panStorageFields,
  sanitizePublicLead,
  toSafeLeadRow,
} from '../src/security/pan-crypto';

process.env.PAN_ENCRYPTION_KEY =
  process.env.PAN_ENCRYPTION_KEY ||
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const sample = 'ABCDE1234F';

assert.strictEqual(isValidPanFormat(sample), true);
assert.strictEqual(isValidPanFormat('BAD'), false);
assert.strictEqual(maskPan(sample), 'ABCDE****F');
assert.strictEqual(isMaskedPan('ABCDE****F'), true);

const cipher = encryptPan(sample);
assert.ok(cipher.startsWith('v1:'));
assert.strictEqual(decryptPan(cipher), sample);
assert.notStrictEqual(hashPan(sample), sample);

const fields = panStorageFields(sample);
assert.strictEqual(fields.pan, 'ABCDE****F');
assert.ok(fields.pan_encrypted);
assert.ok(fields.pan_hash);

const safe = toSafeLeadRow({
  id: '1',
  pan: sample,
  pan_encrypted: fields.pan_encrypted,
  pan_hash: fields.pan_hash,
  notes: 'secret',
});
assert.strictEqual(safe.pan, 'ABCDE****F');
assert.strictEqual('pan_encrypted' in safe, false);
assert.strictEqual('pan_hash' in safe, false);

const pub = sanitizePublicLead({
  id: '1',
  pan: sample,
  pan_encrypted: fields.pan_encrypted,
  pan_hash: fields.pan_hash,
  notes: 'secret',
  full_name: 'Test',
});
assert.strictEqual('pan' in pub, false);
assert.strictEqual('notes' in pub, false);
assert.strictEqual('pan_encrypted' in pub, false);
assert.strictEqual(pub.full_name, 'Test');

console.log('pan-crypto tests: OK');
