import {
  IsOptional,
  IsString,
  Length,
  Matches,
  MinLength,
  IsIn,
  IsObject,
} from 'class-validator';

export const CHAT_STATUSES = [
  'started',
  'otp_sent',
  'otp_verified',
  'lead_submitted',
  'abandoned',
] as const;

export type ChatAnswerItem = { id: string; label: string };
export type ChatAnswers = {
  employment: ChatAnswerItem;
  salary: ChatAnswerItem;
  existing_emi: ChatAnswerItem;
  loan_amount: ChatAnswerItem;
};

export class CreateChatDto {
  @IsString()
  @Length(10, 10, { message: 'Enter a valid 10-digit mobile number.' })
  @Matches(/^[6-9]\d{9}$/, { message: 'Enter a valid 10-digit mobile number.' })
  mobileNumber: string;

  @IsObject()
  answers: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @IsIn([...CHAT_STATUSES])
  status?: string;
}

export class UpdateChatDto {
  @IsOptional()
  @IsString()
  @IsIn([...CHAT_STATUSES])
  status?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  leadId?: string;

  @IsOptional()
  @IsString()
  @MinLength(20)
  idToken?: string;
}

export function isAnswerItem(v: unknown): v is ChatAnswerItem {
  return (
    v != null &&
    typeof v === 'object' &&
    typeof (v as { id?: unknown }).id === 'string' &&
    typeof (v as { label?: unknown }).label === 'string'
  );
}

export function parseAnswers(raw: unknown): ChatAnswers | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (
    !isAnswerItem(o.employment) ||
    !isAnswerItem(o.salary) ||
    !isAnswerItem(o.existing_emi) ||
    !isAnswerItem(o.loan_amount)
  ) {
    return null;
  }
  return {
    employment: { id: o.employment.id, label: o.employment.label },
    salary: { id: o.salary.id, label: o.salary.label },
    existing_emi: { id: o.existing_emi.id, label: o.existing_emi.label },
    loan_amount: { id: o.loan_amount.id, label: o.loan_amount.label },
  };
}
