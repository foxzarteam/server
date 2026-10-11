/**
 * Phone + product apply rule. PAN is not the key.
 * From server/:  npx ts-node --transpile-only scripts/test-mobile-pan-limit.ts
 */
import assert from 'assert';
import {
  CODE_PHONE_PRODUCT_BLOCKED,
  evaluateDuplicateGates,
  type ExistingLeadSnapshot,
} from '../src/leads/mobile-pan-limit';

const MOBILE_A = '9876543210';
const MOBILE_B = '9123456789';

function lead(
  partial: Partial<ExistingLeadSnapshot> & Pick<ExistingLeadSnapshot, 'category'>,
): ExistingLeadSnapshot {
  return {
    id: partial.id ?? `id-${partial.category}-${partial.status ?? 'pending'}`,
    mobile: partial.mobile ?? MOBILE_A,
    panHash: partial.panHash ?? 'hash-ignored',
    category: partial.category,
    insType: partial.insType ?? null,
    status: partial.status ?? 'pending',
    isDraft: partial.isDraft ?? false,
  };
}

{
  const r = evaluateDuplicateGates({
    mobile: MOBILE_A,
    category: 'personal_loan',
    existingLeads: [],
  });
  assert.strictEqual(r.allowed, true);
}

{
  const r = evaluateDuplicateGates({
    mobile: MOBILE_A,
    category: 'home_loan',
    existingLeads: [lead({ category: 'personal_loan', status: 'pending' })],
  });
  assert.strictEqual(r.allowed, true);
}

{
  const r = evaluateDuplicateGates({
    mobile: MOBILE_A,
    category: 'insurance',
    insType: 'health_insurance',
    existingLeads: [lead({ category: 'insurance', insType: 'life_insurance', status: 'pending' })],
  });
  assert.strictEqual(r.allowed, true);
}

{
  const r = evaluateDuplicateGates({
    mobile: MOBILE_A,
    category: 'personal_loan',
    existingLeads: [lead({ category: 'personal_loan', status: 'pending', panHash: 'other-pan' })],
  });
  assert.strictEqual(r.allowed, false);
  if (!r.allowed && r.gate === 2) {
    assert.strictEqual(r.code, CODE_PHONE_PRODUCT_BLOCKED);
    assert.strictEqual(r.status, 'pending');
    assert.match(r.message, /status is pending/i);
  } else {
    assert.fail('expected in-progress block');
  }
}

{
  const r = evaluateDuplicateGates({
    mobile: MOBILE_A,
    category: 'car_loan',
    existingLeads: [lead({ category: 'car_loan', status: 'rejected' })],
  });
  assert.strictEqual(r.allowed, false);
  if (!r.allowed && r.gate === 2) {
    assert.match(r.message, /cannot apply again/i);
  } else {
    assert.fail('expected rejected block');
  }
}

{
  const r = evaluateDuplicateGates({
    mobile: MOBILE_A,
    category: 'business_loan',
    existingLeads: [lead({ category: 'business_loan', status: 'approved' })],
  });
  assert.strictEqual(r.allowed, true);
}

{
  const r = evaluateDuplicateGates({
    mobile: MOBILE_A,
    category: 'personal_loan',
    existingLeads: [
      lead({ id: 'new', category: 'personal_loan', status: 'approved' }),
      lead({ id: 'old', category: 'personal_loan', status: 'rejected' }),
    ],
  });
  assert.strictEqual(r.allowed, true);
}

{
  const r = evaluateDuplicateGates({
    mobile: MOBILE_B,
    category: 'personal_loan',
    existingLeads: [lead({ mobile: MOBILE_A, category: 'personal_loan', status: 'pending' })],
  });
  assert.strictEqual(r.allowed, true);
}

{
  const r = evaluateDuplicateGates({
    mobile: MOBILE_A,
    category: 'personal_loan',
    ignoreLeadId: 'draft-1',
    existingLeads: [lead({ id: 'draft-1', category: 'personal_loan', status: 'pending', isDraft: true })],
  });
  assert.strictEqual(r.allowed, true);
}

console.log('phone-product apply rules ok');
