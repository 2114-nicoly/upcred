/**
 * SHARED progress helpers — used by payment capture (payment-utils),
 * the Rota do Dia (DailyCashPage) and the daily snapshot.
 *
 * There must be exactly ONE way of turning "quanto foi pago" into
 * "4/24 → 7/24", so the historical record and the live screens never
 * disagree.
 */

export type ProgressLoanLike = {
  total_amount: number | string;
  remaining_balance: number | string;
  installment_count: number | string;
  is_imported_ongoing?: boolean | null;
  initial_remaining_balance?: number | string | null;
  amount_already_paid?: number | string | null;
};

const n = (v: unknown) => Number(v ?? 0) || 0;

/** Value of a single installment (total / count). */
export function installmentAmountOf(loan: ProgressLoanLike): number {
  const count = n(loan.installment_count);
  return count > 0 ? n(loan.total_amount) / count : 0;
}

/**
 * Total amount considered "already paid" for the loan, INCLUDING what was
 * paid before importing an ongoing loan (amount_already_paid).
 */
export function totalPaidOf(loan: ProgressLoanLike): number {
  const total = n(loan.total_amount);
  const remaining = n(loan.remaining_balance);
  return Math.max(0, Math.min(total, total - remaining));
}

/** Fractional installment position, e.g. 6.5 for "6,5/24". */
export function progressUnits(paidAmount: number, instAmount: number): number {
  if (!instAmount || instAmount <= 0) return 0;
  return Math.max(0, paidAmount / instAmount);
}

/** Number of FULLY paid installments. */
export function fullyPaidInstallments(paidAmount: number, instAmount: number): number {
  if (!instAmount || instAmount <= 0) return 0;
  return Math.floor((paidAmount + 0.01) / instAmount);
}

/** "6" or "6,5" — partial payments are never rounded up to a full installment. */
export function formatInstFraction(paid: number, instAmount: number): string {
  if (!instAmount || instAmount <= 0) return "0";
  const frac = paid / instAmount;
  const rounded = Math.floor(frac * 10) / 10;
  if (Math.abs(rounded - Math.round(rounded)) < 0.05) return Math.round(rounded).toString();
  return rounded.toFixed(1).replace(".", ",");
}

/** "6,5/24" */
export function formatProgress(paid: number, instAmount: number, count: number): string {
  return `${formatInstFraction(paid, instAmount)}/${count}`;
}

/** "+3" / "+0,5" */
export function formatDelta(deltaPaid: number, instAmount: number): string {
  if (!instAmount || instAmount <= 0 || deltaPaid <= 0) return "+0";
  return `+${formatInstFraction(deltaPaid, instAmount)}`;
}

/** Full frozen progress picture of a loan at a given remaining_balance. */
export function loanProgressAt(loan: ProgressLoanLike, remainingBalance: number) {
  const total = n(loan.total_amount);
  const count = n(loan.installment_count);
  const instAmount = installmentAmountOf(loan);
  const paid = Math.max(0, Math.min(total, total - remainingBalance));
  return {
    total_amount: total,
    total_installments: count,
    installment_amount: instAmount,
    remaining_balance: remainingBalance,
    paid_amount: paid,
    progress_units: progressUnits(paid, instAmount),
    paid_installments: fullyPaidInstallments(paid, instAmount),
    formatted: formatProgress(paid, instAmount, count),
  };
}
