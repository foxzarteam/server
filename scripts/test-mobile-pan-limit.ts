/**
 * Duplicate-detection gates: 4 unique PANs per mobile + existing PAN/product rules.
 * From server/:  npx ts-node --transpile-only scripts/test-mobile-pan-limit.ts
 */
import assert from 'assert';
import {
  applyConcurrentSlotClaims,
  checkMobilePanLimit,
  CODE_MOBILE_PAN_LIMIT_REACHED,
  countsTowardMobilePanLimit,
  evaluateDuplicateGates,
  findBlockingSamePanProductLead,
  isBlockingPanProductStatus,
  isSameProduct,
  MOBILE_PAN_LIMIT,
  MobilePanSlotStore,
  MSG_MOBILE_PAN_LIMIT_REACHED,
  uniquePanHashesForMobile,
  type ExistingLeadSnapshot,
} from '../src/leads/mobile-pan-limit';
import { leadWriteErrorCode, mapLeadWriteError } from '../src/leads/lead-write-errors';

const MOBILE_A = '9876543210';
const MOBILE_B = '9123456789';
const PAN_A = 'hash-A';
const PAN_B = 'hash-B';
const PAN_C = 'hash-C';
const PAN_D = 'hash-D';
const PAN_E = 'hash-E';

function lead(
  partial: Partial<ExistingLeadSnapshot> & Pick<ExistingLeadSnapshot, 'panHash' | 'category'>,
): ExistingLeadSnapshot {
  return {
    id: partial.id ?? `id-${partial.panHash}-${partial.category}`,
    mobile: partial.mobile ?? MOBILE_A,
    panHash: partial.panHash,
    category: partial.category,
    insType: partial.insType ?? null,
    status: partial.status ?? 'pending',
    isDraft: partial.isDraft ?? false,
  };
}

function slotsFromHashes(hashes: string[]) {
  return hashes.map((panHash, i) => ({
    mobile: MOBILE_A,
    panHash,
    slot: i + 1,
  }));
}

// —— 1. first application ALLOW ——
{
  const r = evaluateDuplicateGates({
    mobile: MOBILE_A,
    panHash: PAN_A,
    category: 'personal_loan',
    slots: [],
    existingLeads: [],
  });
  assert.strictEqual(r.allowed, true);
}

// —— 2. second unique PAN same product ALLOW ——
{
  const r = evaluateDuplicateGates({
    mobile: MOBILE_A,
    panHash: PAN_B,
    category: 'personal_loan',
    slots: slotsFromHashes([PAN_A]),
    existingLeads: [lead({ panHash: PAN_A, category: 'personal_loan', status: 'rejected' })],
  });
  assert.strictEqual(r.allowed, true);
}

// —— 3. third unique PAN insurance ALLOW ——
{
  const r = evaluateDuplicateGates({
    mobile: MOBILE_A,
    panHash: PAN_C,
    category: 'insurance',
    insType: 'health_insurance',
    slots: slotsFromHashes([PAN_A, PAN_B]),
    existingLeads: [
      lead({ panHash: PAN_A, category: 'personal_loan', status: 'rejected' }),
      lead({ panHash: PAN_B, category: 'personal_loan', status: 'pending' }),
    ],
  });
  assert.strictEqual(r.allowed, true);
}

// —— 4. fourth unique PAN ALLOW ——
{
  const r = evaluateDuplicateGates({
    mobile: MOBILE_A,
    panHash: PAN_D,
    category: 'personal_loan',
    slots: slotsFromHashes([PAN_A, PAN_B, PAN_C]),
    existingLeads: [],
  });
  assert.strictEqual(r.allowed, true);
}

// —— 5. fifth unique PAN BLOCK ——
{
  const r = evaluateDuplicateGates({
    mobile: MOBILE_A,
    panHash: PAN_E,
    category: 'insurance',
    insType: 'life_insurance',
    slots: slotsFromHashes([PAN_A, PAN_B, PAN_C, PAN_D]),
    existingLeads: [],
  });
  assert.strictEqual(r.allowed, false);
  if (!r.allowed) {
    assert.strictEqual(r.gate, 1);
    assert.strictEqual(r.code, CODE_MOBILE_PAN_LIMIT_REACHED);
    assert.strictEqual(r.message, MSG_MOBILE_PAN_LIMIT_REACHED);
  }
}

// —— 6. same PAN again does not increase count ——
{
  const slots = slotsFromHashes([PAN_A, PAN_B, PAN_C, PAN_D]);
  const before = uniquePanHashesForMobile(MOBILE_A, slots);
  const gate1 = checkMobilePanLimit({
    mobile: MOBILE_A,
    panHash: PAN_A,
    slots,
  });
  assert.strictEqual(gate1.allowed, true);
  assert.strictEqual(before.length, 4);
  assert.strictEqual(uniquePanHashesForMobile(MOBILE_A, slots).length, 4);
}

// —— 7. PAN A rejected + PAN B same product ALLOW if under 4 ——
{
  const r = evaluateDuplicateGates({
    mobile: MOBILE_A,
    panHash: PAN_B,
    category: 'personal_loan',
    slots: slotsFromHashes([PAN_A]),
    existingLeads: [lead({ panHash: PAN_A, category: 'personal_loan', status: 'rejected' })],
  });
  assert.strictEqual(r.allowed, true);
}

// —— 8. PAN A pending + same PAN same product BLOCK ——
{
  const r = evaluateDuplicateGates({
    mobile: MOBILE_A,
    panHash: PAN_A,
    category: 'personal_loan',
    slots: slotsFromHashes([PAN_A]),
    existingLeads: [lead({ panHash: PAN_A, category: 'personal_loan', status: 'pending' })],
  });
  assert.strictEqual(r.allowed, false);
  if (!r.allowed) assert.strictEqual(r.gate, 2);
}

// —— 9. PAN A rejected + same PAN different product ALLOW ——
{
  const r = evaluateDuplicateGates({
    mobile: MOBILE_A,
    panHash: PAN_A,
    category: 'insurance',
    insType: 'life_insurance',
    slots: slotsFromHashes([PAN_A]),
    existingLeads: [lead({ panHash: PAN_A, category: 'personal_loan', status: 'rejected' })],
  });
  assert.strictEqual(r.allowed, true);
}

// —— 10. Health vs Motor remain separate products ——
{
  assert.strictEqual(
    isSameProduct(
      { category: 'insurance', insType: 'health_insurance' },
      { category: 'insurance', insType: 'motor_insurance' },
    ),
    false,
  );
  const r = evaluateDuplicateGates({
    mobile: MOBILE_A,
    panHash: PAN_A,
    category: 'insurance',
    insType: 'motor_insurance',
    slots: slotsFromHashes([PAN_A]),
    existingLeads: [
      lead({
        panHash: PAN_A,
        category: 'insurance',
        insType: 'health_insurance',
        status: 'rejected',
      }),
    ],
  });
  assert.strictEqual(r.allowed, true);
}

// —— 11. four rejected PANs → 5th still BLOCKED ——
{
  const r = evaluateDuplicateGates({
    mobile: MOBILE_A,
    panHash: PAN_E,
    category: 'personal_loan',
    slots: slotsFromHashes([PAN_A, PAN_B, PAN_C, PAN_D]),
    existingLeads: [
      lead({ panHash: PAN_A, category: 'personal_loan', status: 'rejected' }),
      lead({ panHash: PAN_B, category: 'personal_loan', status: 'rejected' }),
      lead({ panHash: PAN_C, category: 'personal_loan', status: 'rejected' }),
      lead({ panHash: PAN_D, category: 'personal_loan', status: 'rejected' }),
    ],
  });
  assert.strictEqual(r.allowed, false);
  if (!r.allowed) assert.strictEqual(r.gate, 1);
}

// —— 12. approved PAN still consumes a slot ——
{
  const r = checkMobilePanLimit({
    mobile: MOBILE_A,
    panHash: PAN_E,
    slots: [
      { mobile: MOBILE_A, panHash: PAN_A },
      { mobile: MOBILE_A, panHash: PAN_B },
      { mobile: MOBILE_A, panHash: PAN_C },
      { mobile: MOBILE_A, panHash: PAN_D },
    ],
  });
  assert.strictEqual(r.allowed, false);
}

// —— 13. draft with no PAN does not consume a slot ——
{
  assert.strictEqual(
    countsTowardMobilePanLimit({ panHash: null, isDraft: true }),
    false,
  );
  const store = new MobilePanSlotStore();
  const draftClaim = store.claim(MOBILE_A, '');
  assert.strictEqual(draftClaim.ok, true);
  assert.strictEqual(store.snapshot(MOBILE_A).length, 0);
}

// —— 14. completing a draft with a new PAN consumes a slot ——
{
  const store = new MobilePanSlotStore();
  const result = store.claim(MOBILE_A, PAN_A);
  assert.strictEqual(result.ok, true);
  if (result.ok) {
    assert.strictEqual(result.reused, false);
    assert.strictEqual(result.slot, 1);
  }
  assert.strictEqual(store.snapshot(MOBILE_A).length, 1);
}

// —— 15. same PAN + different mobile + same open product BLOCK (existing safeguard) ——
{
  const blocking = findBlockingSamePanProductLead(
    { panHash: PAN_A, category: 'personal_loan' },
    [
      lead({
        mobile: MOBILE_A,
        panHash: PAN_A,
        category: 'personal_loan',
        status: 'pending',
      }),
    ],
  );
  assert.ok(blocking);
  const r = evaluateDuplicateGates({
    mobile: MOBILE_B,
    panHash: PAN_A,
    category: 'personal_loan',
    slots: [],
    existingLeads: [
      lead({
        mobile: MOBILE_A,
        panHash: PAN_A,
        category: 'personal_loan',
        status: 'in_process',
      }),
    ],
  });
  assert.strictEqual(r.allowed, false);
  if (!r.allowed) assert.strictEqual(r.gate, 2);
}

// —— 16 & 17. admin/partner creation uses the same gates ——
{
  const admin = evaluateDuplicateGates({
    mobile: MOBILE_A,
    panHash: PAN_E,
    category: 'personal_loan',
    slots: slotsFromHashes([PAN_A, PAN_B, PAN_C, PAN_D]),
    existingLeads: [],
  });
  assert.strictEqual(admin.allowed, false);
  const partner = evaluateDuplicateGates({
    mobile: MOBILE_A,
    panHash: PAN_B,
    category: 'personal_loan',
    slots: slotsFromHashes([PAN_A]),
    existingLeads: [lead({ panHash: PAN_A, category: 'personal_loan', status: 'rejected' })],
  });
  assert.strictEqual(partner.allowed, true);
}

// —— 18. admin changing mobile/PAN cannot create a 5th relationship ——
{
  const r = checkMobilePanLimit({
    mobile: MOBILE_A,
    panHash: PAN_E,
    slots: slotsFromHashes([PAN_A, PAN_B, PAN_C, PAN_D]),
  });
  assert.strictEqual(r.allowed, false);
}

// —— 19. same PAN concurrent → one relationship, reused slot ——
{
  const { results, final } = applyConcurrentSlotClaims([], [PAN_A, PAN_A]);
  assert.strictEqual(results[0]?.ok, true);
  assert.strictEqual(results[1]?.ok, true);
  if (results[1]?.ok) assert.strictEqual(results[1].reused, true);
  assert.strictEqual(final.length, 1);
}

// —— 20. 3 PANs + two simultaneous new PANs → only one gets slot 4 ——
{
  const existing = slotsFromHashes([PAN_A, PAN_B, PAN_C]);
  const { results, final } = applyConcurrentSlotClaims(existing, [PAN_D, PAN_E]);
  const allowed = results.filter((r) => r.ok);
  const blocked = results.filter((r) => !r.ok);
  assert.strictEqual(allowed.length, 1);
  assert.strictEqual(blocked.length, 1);
  assert.strictEqual(final.length, 4);
  if (!blocked[0]?.ok) {
    assert.strictEqual(blocked[0].code, CODE_MOBILE_PAN_LIMIT_REACHED);
  }
}

// —— extra: rejected/pending/action_required block; approved does not ——
assert.strictEqual(isBlockingPanProductStatus('rejected', false), true);
assert.strictEqual(isBlockingPanProductStatus('action_required', false), true);
assert.strictEqual(isBlockingPanProductStatus('approved', false), false);
assert.strictEqual(isBlockingPanProductStatus('pending', true), false);

// —— extra: store max 4 ——
{
  const store = new MobilePanSlotStore();
  assert.strictEqual(store.claim(MOBILE_A, PAN_A).ok, true);
  assert.strictEqual(store.claim(MOBILE_A, PAN_B).ok, true);
  assert.strictEqual(store.claim(MOBILE_A, PAN_C).ok, true);
  assert.strictEqual(store.claim(MOBILE_A, PAN_D).ok, true);
  const fifth = store.claim(MOBILE_A, PAN_E);
  assert.strictEqual(fifth.ok, false);
  const reuse = store.claim(MOBILE_A, PAN_A);
  assert.strictEqual(reuse.ok, true);
  if (reuse.ok) assert.strictEqual(reuse.reused, true);
  assert.strictEqual(MOBILE_PAN_LIMIT, 4);
}

// —— write-error mapping preserves 4-PAN code/message ——
assert.strictEqual(
  mapLeadWriteError('MOBILE_PAN_LIMIT_REACHED'),
  MSG_MOBILE_PAN_LIMIT_REACHED,
);
assert.strictEqual(
  leadWriteErrorCode('duplicate key on lead_mobile_pan_slots'),
  CODE_MOBILE_PAN_LIMIT_REACHED,
);
assert.strictEqual(
  mapLeadWriteError('duplicate key value violates unique constraint "leads_pan_hash_product_open_uidx"'),
  'You already have an open application for this product. Check status or wait until it is Approved before applying again.',
);

console.log('test-mobile-pan-limit: all asserts passed');
