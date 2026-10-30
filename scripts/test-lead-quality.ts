/**
 * Lead quality self-check (IP, geo helpers, write errors, public sanitize).
 * From server/:  npm run test:leads
 */
import assert from 'assert';
import { extractClientIp, requestRateLimitIp } from '../src/common/client-ip';
import {
  buildLocationLabel,
  isPrivateOrLocalIp,
} from '../src/common/ip-geo';
import { mapLeadWriteError } from '../src/leads/lead-write-errors';
import { LeadRuleError, leadRuleField } from '../src/leads/mobile-pan-limit';
import { leadFullNameError, kycEmploymentBucket, loanNotEligibleMessage, loanProfileError, personalLoanEmploymentError } from '../src/leads/personal-loan-employment';
import { isStoredLoanCategory, personalLoanAmountError } from '../src/wallet/loan-amount';
import { sanitizePublicLead } from '../src/security/pan-crypto';
import { slugToLeadCategory, isInsTypeSlug } from '../src/catalog/catalog';
import { statusLabel } from '../src/leads/lead-present';
import { underReviewText } from '../src/whatsapp/whatsapp-templates';

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
assert.strictEqual(
  extractClientIp({
    'x-az-client-ip': '203.0.113.10',
    'x-forwarded-for': '8.8.8.8',
  }),
  '203.0.113.10',
);
assert.strictEqual(
  extractClientIp({ 'x-forwarded-for': '10.0.0.1, 203.0.113.10' }),
  '203.0.113.10',
);
assert.strictEqual(
  extractClientIp({ 'x-forwarded-for': '8.8.8.8' }, null, '203.0.113.99'),
  '203.0.113.99',
);
assert.strictEqual(
  requestRateLimitIp({
    headers: { 'x-az-client-ip': '203.0.113.10', 'x-forwarded-for': '198.51.100.7' },
  }),
  '198.51.100.7',
);

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
assert.ok(personalLoanEmploymentError({})?.includes('income'));
assert.strictEqual(personalLoanEmploymentError({ netMonthlyIncome: 50000 }), null);
assert.ok(
  personalLoanEmploymentError({ category: 'personal_loan', netMonthlyIncome: 50000 })?.includes('salaried'),
);
assert.strictEqual(
  personalLoanEmploymentError({
    category: 'personal_loan',
    netMonthlyIncome: 50000,
    employmentType: 'self_employed',
  }),
  null,
);
assert.ok(
  personalLoanEmploymentError({ category: 'vehicle_loan', netMonthlyIncome: 12000 })?.includes('salaried'),
);
assert.strictEqual(
  personalLoanEmploymentError({
    category: 'vehicle_loan',
    netMonthlyIncome: 12000,
    employmentType: 'salaried_bank',
  }),
  null,
);
assert.strictEqual(
  personalLoanEmploymentError({ netMonthlyIncome: 50000, employmentType: 'salaried' }),
  null,
);
assert.strictEqual(
  personalLoanEmploymentError({ netMonthlyIncome: 50000, employmentType: 'salaried_bank' }),
  null,
);
assert.strictEqual(
  personalLoanEmploymentError({ netMonthlyIncome: 50000, employmentType: 'salaried_cash' }),
  null,
);
assert.ok(personalLoanEmploymentError({ netMonthlyIncome: 17999, employmentType: 'salaried_bank' })?.includes('18,000'));
assert.strictEqual(
  personalLoanEmploymentError({ netMonthlyIncome: 18000, employmentType: 'salaried_bank' }),
  null,
);
assert.strictEqual(
  loanNotEligibleMessage({ netMonthlyIncome: 50000, cibilBand: 'below_680', hasExistingEmi: false, totalMonthlyEmi: 0 }),
  'Sorry, you are not eligible for this loan. A CIBIL score below 680 does not meet the current criteria.',
);
assert.strictEqual(
  loanNotEligibleMessage({ netMonthlyIncome: 50000, cibilBand: 'above_680', hasExistingEmi: false, totalMonthlyEmi: 0 }),
  null,
);
assert.strictEqual(
  loanNotEligibleMessage({ netMonthlyIncome: 17000, cibilBand: 'above_680', hasExistingEmi: true, totalMonthlyEmi: 1000 }),
  null,
);
assert.strictEqual(
  loanNotEligibleMessage({ netMonthlyIncome: 40000, cibilBand: 'above_680', hasExistingEmi: true, totalMonthlyEmi: 20000 }),
  'Sorry, you are not eligible for this loan. Your existing EMI is half or more of your net monthly income.',
);
assert.strictEqual(
  loanNotEligibleMessage({ netMonthlyIncome: 40000, cibilBand: 'above_680', hasExistingEmi: true, totalMonthlyEmi: 19999 }),
  null,
);
assert.strictEqual(
  personalLoanEmploymentError({
    category: 'vehicle_loan',
    netMonthlyIncome: 10000,
    employmentType: 'self_employed',
  }),
  null,
);
assert.ok(personalLoanEmploymentError({ category: 'vehicle_loan', netMonthlyIncome: 9999 })?.includes('10,000'));
assert.ok(
  loanNotEligibleMessage({
    category: 'vehicle_loan',
    netMonthlyIncome: 20000,
    cibilBand: 'below_650',
    hasExistingEmi: false,
    totalMonthlyEmi: 0,
  })?.includes('650'),
);
assert.strictEqual(
  loanNotEligibleMessage({
    category: 'vehicle_loan',
    netMonthlyIncome: 20000,
    cibilBand: 'above_650',
    hasExistingEmi: true,
    totalMonthlyEmi: 15000,
  }),
  null,
);
assert.strictEqual(loanProfileError({ category: 'vehicle_loan', cibilBand: 'unknown' }), null);
assert.strictEqual(loanProfileError({ cibilBand: 'above_680', hasExistingEmi: false, totalMonthlyEmi: 0 }), null);
assert.strictEqual(loanProfileError({ cibilBand: 'unknown', hasExistingEmi: true, totalMonthlyEmi: 4500 }), null);
assert.ok(loanProfileError({ cibilBand: 'above_680', hasExistingEmi: true, totalMonthlyEmi: 0 }));
assert.ok(loanProfileError({ cibilBand: 'nope', hasExistingEmi: false, totalMonthlyEmi: 0 }));
assert.strictEqual(kycEmploymentBucket('salaried_cash'), 'salaried');
assert.strictEqual(kycEmploymentBucket('self_employed'), 'self_employed');
assert.strictEqual(kycEmploymentBucket('Self-Employed / Business'), 'self_employed');

assert.strictEqual(leadFullNameError('Rahul Sharma'), null);
assert.ok(leadFullNameError('A')?.includes('required'));
assert.ok(leadFullNameError('Rahul123')?.includes('special'));

assert.strictEqual(personalLoanAmountError(500000), null);
assert.strictEqual(personalLoanAmountError(20_00_000), null);
assert.strictEqual(personalLoanAmountError(50_00_000), null);
assert.ok(personalLoanAmountError(1000));
assert.ok(personalLoanAmountError(50_00_001));
assert.strictEqual(personalLoanAmountError(15_000, { min: 10_000, max: 20_000 }), null);
assert.ok(personalLoanAmountError(9_000, { min: 10_000, max: 20_000 }));
assert.ok(personalLoanAmountError(20_001, { min: 10_000, max: 20_000 }));
assert.strictEqual(isStoredLoanCategory('personal_loan'), true);
assert.strictEqual(isStoredLoanCategory('home_loan'), true);
assert.strictEqual(isStoredLoanCategory('car_loan'), true);
assert.strictEqual(isStoredLoanCategory('business_loan'), true);
assert.strictEqual(isStoredLoanCategory('insurance'), false);
assert.strictEqual(isStoredLoanCategory('credit_card'), false);

// —— write errors ——
assert.strictEqual(
  mapLeadWriteError('duplicate key value violates unique constraint'),
  'You already have an open application for this product. Check status or wait until it is Approved before applying again.',
);
assert.strictEqual(
  mapLeadWriteError('MOBILE_PAN_LIMIT_REACHED'),
  'This mobile number has already been used for multiple applications. Please use a different mobile number.',
);
assert.ok(mapLeadWriteError("Could not find the 'ip_location' column of 'leads' in the schema cache").includes('updating'));
assert.strictEqual(
  mapLeadWriteError('insert or update on table "leads" violates foreign key constraint "leads_ins_type_fkey"'),
  'Invalid insurance type. Please try again.',
);
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

assert.strictEqual(slugToLeadCategory('personal-loan'), 'personal_loan');
assert.strictEqual(slugToLeadCategory('insurance'), 'insurance');
assert.strictEqual(slugToLeadCategory('gold-loan'), 'gold_loan');
assert.strictEqual(isInsTypeSlug('cyber_insurance'), true);
assert.strictEqual(isInsTypeSlug('Travel Insurance'), false);

assert.strictEqual(statusLabel('pending'), 'KYC pending');
assert.strictEqual(statusLabel('kyc_progress'), 'KYC progress');
assert.ok(/received your KYC documents/.test(underReviewText()));
assert.ok(/under review/.test(underReviewText()));
assert.strictEqual(statusLabel('in_process'), 'Under Review');
assert.strictEqual(statusLabel('approved'), 'Approved');
assert.strictEqual(statusLabel('rejected'), 'Not Approved');
assert.strictEqual(statusLabel('action_required'), 'KYC pending');
assert.strictEqual(statusLabel('PENDING'), 'KYC pending');

assert.strictEqual(leadRuleField(new LeadRuleError('Select vehicle category.')), 'vehicleCategory');
assert.strictEqual(leadRuleField(new LeadRuleError('Net monthly income must be at least ₹10,000')), 'netMonthlyIncome');
assert.strictEqual(leadRuleField(new LeadRuleError('Sorry, below 650.', 'LOAN_NOT_ELIGIBLE')), undefined);
assert.strictEqual(leadRuleField(new LeadRuleError('Invalid PAN format.')), 'pan');

async function assertAdminVehicleDto() {
  const { validate } = await import('class-validator');
  const { AdminCreateLeadDto } = await import('../src/leads/leads.dto');
  const vehicle = Object.assign(new AdminCreateLeadDto(), {
    pan: 'ABCDE1234F',
    mobileNumber: '9876543210',
    fullName: 'Raju Patel',
    pincode: '302002',
    category: 'vehicle_loan',
    requiredAmount: 200000,
    netMonthlyIncome: 10000,
    cibilBand: 'above_650',
    vehicleCategory: 'taxi',
    employmentType: 'salaried_bank',
  });
  const vehicleErrors = await validate(vehicle);
  assert.strictEqual(
    vehicleErrors.map((error) => error.property).join(','),
    '',
  );

  const lowIncome = Object.assign(new AdminCreateLeadDto(), { ...vehicle, netMonthlyIncome: 9999 });
  const lowErrors = await validate(lowIncome);
  assert.ok(lowErrors.some((error) => error.property === 'netMonthlyIncome'));

  const personal = Object.assign(new AdminCreateLeadDto(), {
    pan: 'ABCDE1234F',
    mobileNumber: '9876543210',
    fullName: 'Raju Patel',
    category: 'personal_loan',
    netMonthlyIncome: 20000,
    cibilBand: 'above_680',
  });
  const personalErrors = await validate(personal);
  const personalFields = personalErrors.map((error) => error.property);
  assert.ok(personalFields.includes('employmentType'));
  assert.ok(personalFields.includes('hasExistingEmi'));
  assert.ok(personalFields.includes('totalMonthlyEmi'));
}

assertAdminVehicleDto()
  .then(() => {
    console.log('test-lead-quality: all asserts passed');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
