/**
 * Authz / attribution gates that must stay fail-closed (no DB).
 */
import { requiresAdminCommissionGate } from '../src/wallet/wallet-sync';
import { allowRateLimitedAction } from '../src/security/rate-limit';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(
  requiresAdminCommissionGate(
    { status: 'pending', agent_id: 'a' },
    { status: 'approved', agent_id: 'a' },
  ),
  'staff must not approve',
);

assert(
  requiresAdminCommissionGate(
    { status: 'approved', agent_id: 'a', required_amount: 1 },
    { status: 'approved', agent_id: 'a', required_amount: 2 },
  ),
  'staff must not change approved amount',
);

const key = `authz-test:${Date.now()}`;
assert(allowRateLimitedAction(key, 2, 60_000) === true, 'first allow');
assert(allowRateLimitedAction(key, 2, 60_000) === true, 'second allow');
assert(allowRateLimitedAction(key, 2, 60_000) === false, 'third blocked');

console.log('test-authz-gates: ok');
