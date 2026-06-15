/**
 * Centralized status constants for loans and installments.
 * Use these instead of scattering raw strings.
 */

export const LOAN_STATUS = {
  OPEN: "open",
  OVERDUE: "overdue",
  PAID: "paid",
  CANCELLED: "cancelled",
  RENEGOTIATED: "renegotiated",
} as const;

export const LOAN_ACTIVE_STATUSES = [LOAN_STATUS.OPEN, LOAN_STATUS.OVERDUE] as const;
export const LOAN_INACTIVE_STATUSES = [
  LOAN_STATUS.PAID,
  LOAN_STATUS.CANCELLED,
  LOAN_STATUS.RENEGOTIATED,
] as const;

export function isLoanActive(loan: { status?: string | null; remaining_balance?: number | string | null }): boolean {
  return (LOAN_ACTIVE_STATUSES as readonly string[]).includes(String(loan.status))
    && Number(loan.remaining_balance) > 0.01;
}

/** For Supabase `.not("status","in", ...)` filter on loans. */
export const LOAN_INACTIVE_FILTER = `(${LOAN_INACTIVE_STATUSES.join(",")})`;

export const INSTALLMENT_STATUS = {
  PENDING: "pending",
  PARTIAL: "partial",
  OVERDUE: "overdue",
  PAID: "paid",
  CANCELLED: "cancelled",
  RENEGOTIATED: "renegotiated",
} as const;

/** Installments that can still receive payment / be enforced. */
export const INSTALLMENT_COLLECTIBLE_STATUSES = [
  INSTALLMENT_STATUS.PENDING,
  INSTALLMENT_STATUS.PARTIAL,
  INSTALLMENT_STATUS.OVERDUE,
] as const;

export const INSTALLMENT_INACTIVE_STATUSES = [
  INSTALLMENT_STATUS.PAID,
  INSTALLMENT_STATUS.CANCELLED,
  INSTALLMENT_STATUS.RENEGOTIATED,
] as const;

/** Installments that must never be changed by payment redistribution. */
export const INSTALLMENT_LOCKED_STATUSES = [
  INSTALLMENT_STATUS.CANCELLED,
  INSTALLMENT_STATUS.RENEGOTIATED,
] as const;

export function isInstallmentCollectibleStatus(status: string | null | undefined): boolean {
  return (INSTALLMENT_COLLECTIBLE_STATUSES as readonly string[]).includes(String(status));
}
