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
