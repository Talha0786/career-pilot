/** Domain error taxonomy. Interface adapters map these to transport codes. */

export type DomainErrorCode =
  | 'validation_failed'
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'invalid_credentials'
  | 'invalid_transition'
  | 'budget_exceeded';

export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, string>>;
}

const make =
  (code: DomainErrorCode) =>
  (message: string, details?: Record<string, string>): DomainError =>
    details === undefined ? { code, message } : { code, message, details };

export const validationFailed = make('validation_failed');
export const notFound = make('not_found');
export const forbidden = make('forbidden');
export const conflict = make('conflict');
export const invalidCredentials = make('invalid_credentials');
export const invalidTransition = make('invalid_transition');
export const budgetExceeded = make('budget_exceeded');
