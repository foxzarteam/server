import { HttpException, HttpStatus } from '@nestjs/common';
import { CODE_LOAN_AMOUNT_REQUIRED } from '../wallet/loan-amount';
import { CODE_APPROVE_ADMIN_ONLY, WalletSyncError } from '../wallet/wallet-sync';
import { LeadRuleError } from './mobile-pan-limit';

/** Map lead-rule / wallet failures to the same HTTP body both panel APIs already return. */
export function throwLeadMutation(err: unknown): never {
  if (err instanceof WalletSyncError) {
    throw new HttpException(
      {
        success: false,
        message: err.message,
        code: err.code,
        leadStatusSaved: err.leadStatusSaved,
      },
      err.leadStatusSaved ? HttpStatus.INTERNAL_SERVER_ERROR : HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
  if (err instanceof LeadRuleError) {
    const status =
      err.code === CODE_APPROVE_ADMIN_ONLY
        ? HttpStatus.FORBIDDEN
        : err.code === CODE_LOAN_AMOUNT_REQUIRED
          ? HttpStatus.BAD_REQUEST
          : HttpStatus.CONFLICT;
    throw new HttpException(
      { success: false, message: err.message, code: err.code },
      status,
    );
  }
  throw err;
}
