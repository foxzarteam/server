/**
 * Lead quality self-check (IP, geo helpers, write errors, public sanitize).
 * From server/:  npm run test:leads
 */
import assert from 'assert';
import { extractClientIp } from '../src/common/client-ip';
import {
  buildLocationLabel,
  isPrivateOrLocalIp,
} from '../src/common/ip-geo';
import { mapLeadWriteError } from '../src/leads/lead-write-errors';
import { personalLoanEmploymentError } from '../src/leads/personal-loan-employment';
import { sanitizePublicLead } from '../src/security/pan-crypto';

// —— client IP ——
assert.strictEqual(
  extractClientIp({ 'x-forwarded-for': '203.0.113.10, 10.0.0.1' }),
  '203.0.113.10',
);
assert.strictEqual(
  extractClientIp({ 'cf-connecting-ip': '198.51.100.7' }),
  '198.51.100.7',
);
assert.strictEqual(extractClientIp({}, '::ffff:192.0.2.1'), '192.0.2.1');
assert.strictEqual(extractClientIp({}), null);

// —— private ranges ——
assert.strictEqual(isPrivateOrLocalIp('127.0.0.1'), true);
assert.strictEqual(isPrivateOrLocalIp('10.1.2.3'), true);
assert.strictEqual(isPrivateOrLocalIp('192.168.1.1'), true);
assert.strictEqual(isPrivateOrLocalIp('172.16.0.1'), true);
assert.strictEqual(isPrivateOrLocalIp('172.31.255.1'), true);
assert.strictEqual(isPrivateOrLocalIp('172.32.0.1'), false);
assert.strictEqual(isPrivateOrLocalIp('8.8.8.8'), false);

// —— location label ——
assert.strictEqual(
  buildLocationLabel(['Jaipur', 'Rajasthan', 'India']),
  'Jaipur, Rajasthan, India',
);
assert.strictEqual(buildLocationLabel(['Mumbai', '', 'India', 'Mumbai']), 'Mumbai, India');
assert.strictEqual(buildLocationLabel([null, undefined, '']), null);

// —— employment ——
assert.ok(personalLoanEmploymentError({}).includes('Employment'));
assert.ok(
  personalLoanEmploymentError({ employmentType: 'salaried' })?.includes('income'),
);
assert.strictEqual(
  personalLoanEmploymentError({ employmentType: 'salaried', netMonthlyIncome: 50000 }),
  null,
);

// —— write errors ——
assert.strictEqual(
  mapLeadWriteError('duplicate key value violates unique constraint'),
  'You already have an application for this product.',
);
assert.ok(mapLeadWriteError("Could not find the 'ip_location' column of 'leads' in the schema cache").includes('updating'));
assert.strictEqual(
  mapLeadWriteError('something random'),
  'Failed to create lead. Please try again.',
);

// —— public sanitize strips IP fields ——
const pub = sanitizePublicLead({
  id: '1',
  full_name: 'Test',
  pan: 'ABCDE****F',
  ip: '203.0.113.1',
  ip_location: 'Jaipur, India',
  notes: 'secret',
});
assert.strictEqual('ip' in pub, false);
assert.strictEqual('ip_location' in pub, false);
assert.strictEqual('notes' in pub, false);
assert.strictEqual('pan' in pub, false);

console.log('test-lead-quality: all asserts passed');
