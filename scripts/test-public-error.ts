/**
 * Public error sanitizer — no DB/stack/config strings to clients.
 */
import { looksLikeInternalError, toPublicErrorMessage } from '../src/common/public-error';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(
  toPublicErrorMessage('Could not find the ip_location column of leads in the schema cache') ===
    'Something went wrong. Please try again.',
  'schema cache is hidden',
);
assert(
  toPublicErrorMessage('duplicate key value violates unique constraint "users_mobile_number_key"') ===
    'This phone number is already registered. Please log in.',
  'duplicate mobile is mapped',
);
assert(
  toPublicErrorMessage('TypeError: Cannot read properties of undefined (reading "id")') ===
    'Something went wrong. Please try again.',
  'TypeError is hidden',
);
assert(
  toPublicErrorMessage('property confirmCommission should not exist') ===
    'Some details are invalid. Please check and try again.',
  'whitelist leak is hidden',
);
assert(
  toPublicErrorMessage('ECONNREFUSED 127.0.0.1:5432') ===
    'Something went wrong. Please try again.',
  'connection error is hidden',
);
assert(
  toPublicErrorMessage('Enter a valid 10-digit Indian mobile number.') ===
    'Enter a valid 10-digit Indian mobile number.',
  'safe validation message is kept',
);
assert(
  toPublicErrorMessage(
    'This mobile number has already been used for multiple applications. Please use a different mobile number.',
  ).includes('different mobile number'),
  'known PAN-limit copy is kept',
);
assert(looksLikeInternalError('at LeadsService.updateById (src/leads/leads.service.ts:12)') === true, 'stack looks internal');
assert(looksLikeInternalError('Set a loan amount before approving this personal loan.') === false, 'business copy is public');
assert(
  toPublicErrorMessage(
    'Only an admin can approve or un-approve a lead (this credits partner commission).',
  ) === 'Only an admin can approve or un-approve a lead (this credits partner commission).',
  'admin-only approve copy is kept',
);

console.log('test-public-error: ok');
