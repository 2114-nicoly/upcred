/**
 * Centralized status values for loans and installments.
 * Use these constants instead of magic strings.
 */
export const LOAN_STATUS = {
  OPEN: "open",
  PAID: "paid",
  OVERDUE: "overdue",
  CANCELLED: "cancelled",
  RENEGOTIATED: "renegotiated",
} as const;
export type LoanStatus = (typeof LOAN_STATUS)[keyof typeof LOAN_STATUS];

export const INSTALLMENT_STATUS = {
  PENDING: "pending",
  PARTIAL: "partial",
  PAID: "paid",
  OVERDUE: "overdue",
  CANCELLED: "cancelled",
  RENEGOTIATED: "renegotiated",
} as const;
export type InstallmentStatus = (typeof INSTALLMENT_STATUS)[keyof typeof INSTALLMENT_STATUS];

/** Loans that are no longer in the active flow (no overdue recalculation, hidden from "ativos") */
export const INACTIVE_LOAN_STATUSES: readonly string[] = [
  LOAN_STATUS.CANCELLED,
  LOAN_STATUS.RENEGOTIATED,
  LOAN_STATUS.PAID,
];

/** Installments that should NOT be considered when computing pending/overdue lists */
export const INACTIVE_INSTALLMENT_STATUSES: readonly string[] = [
  INSTALLMENT_STATUS.PAID,
  INSTALLMENT_STATUS.CANCELLED,
  INSTALLMENT_STATUS.RENEGOTIATED,
];
