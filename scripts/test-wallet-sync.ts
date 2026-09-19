/**
 * Pure checks for commission-affecting status changes (no DB).
 */
import {
  isCommissionAffectingChange,
  isApprovedLeadStatus,
  requiresAdminCommissionGate,
} from '../src/wallet/wallet-sync';
import {
  amountFromLoanAmtRange,
  leadLoanAmount,
  resolvePersonalLoanAmounts,
} from '../src/wallet/loan-amount';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(isApprovedLeadStatus('Approved') === true, 'approved case-insensitive');
assert(isApprovedLeadStatus('pending') === false, 'pending is not approved');

assert(
  isCommissionAffectingChange(
    { status: 'pending', agent_id: 'a' },
    { status: 'approved', agent_id: 'a' },
  ),
  'pending → approved is commission',
);
assert(
  isCommissionAffectingChange(
    { status: 'approved', agent_id: 'a' },
    { status: 'rejected', agent_id: 'a' },
  ),
  'approved → rejected is commission',
);
assert(
  !isCommissionAffectingChange(
    { status: 'pending', agent_id: 'a' },
    { status: 'in_process', agent_id: 'a' },
  ),
  'pending → in_process is not commission',
);
assert(
  isCommissionAffectingChange(
    { status: 'approved', agent_id: 'a' },
    { status: 'approved', agent_id: 'b' },
  ),
  'reassign approved agent is commission',
);
assert(
  !isCommissionAffectingChange(
    { status: 'approved', agent_id: 'a' },
    { status: 'approved', agent_id: 'a' },
  ),
  'same approved+agent is not a new commission event',
);

assert(
  requiresAdminCommissionGate(
    { status: 'approved', agent_id: 'a', required_amount: 100000, category: 'personal_loan' },
    { status: 'approved', agent_id: 'a', required_amount: 200000, category: 'personal_loan' },
  ),
  'amount change on approved lead is admin-only',
);
assert(
  !requiresAdminCommissionGate(
    { status: 'pending', agent_id: 'a', required_amount: 100000, category: 'personal_loan' },
    { status: 'in_process', agent_id: 'a', required_amount: 200000, category: 'personal_loan' },
  ),
  'amount change on non-approved lead is not admin-only',
);
assert(
  requiresAdminCommissionGate(
    { status: 'approved', agent_id: 'a', required_amount: 100000, category: 'personal_loan' },
    { status: 'approved', agent_id: 'a', required_amount: 100000, category: 'insurance' },
  ),
  'product change on approved lead is admin-only',
);

assert(amountFromLoanAmtRange('25000_100000') === 62500, 'range midpoint');
assert(amountFromLoanAmtRange('') === 0, 'empty range');
assert(
  leadLoanAmount({ required_amount: 200000, loan_amt: '25000_100000' }) === 200000,
  'exact amount wins over range',
);
assert(
  leadLoanAmount({ required_amount: null, loan_amt: '100000_200000' }) === 150000,
  'fallback to range midpoint',
);
assert(
  resolvePersonalLoanAmounts({ requiredAmount: null, loanAmt: '400000_500000' })
    .requiredAmount === 450000,
  'persist midpoint when only range is sent',
);

console.log('test-wallet-sync: ok');
