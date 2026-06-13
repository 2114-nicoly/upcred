import { addDays, addWeeks, addMonths } from "date-fns";

const weekdayNames: Record<number, string> = {
  0: "Domingo", 1: "Segunda", 2: "Terça", 3: "Quarta", 4: "Quinta", 5: "Sexta", 6: "Sábado",
};

export function getPaymentTypeLabel(paymentType: string, firstDueDate?: string | null): string {
  const labels: Record<string, string> = {
    daily: "Diário", weekly: "Semanal", biweekly: "Quinzenal", monthly: "Mensal", fixed_dates: "Data Fixa",
  };
  const base = labels[paymentType] || paymentType;
  if (paymentType === "weekly" && firstDueDate) {
    const day = new Date(firstDueDate + "T12:00:00").getDay();
    return `${base} (${weekdayNames[day]})`;
  }
  return base;
}

export function calculateLoan(
  amount: number,
  interestType: "percentage" | "fixed",
  interestValue: number,
  installmentCount: number
) {
  const interest = interestType === "percentage" ? amount * (interestValue / 100) : interestValue;
  const totalAmount = amount + interest;
  const installmentAmount = totalAmount / installmentCount;
  return { interest, totalAmount, installmentAmount };
}

export function generateDueDates(
  firstDueDate: Date,
  installmentCount: number,
  paymentType: "daily" | "weekly" | "biweekly" | "monthly"
): Date[] {
  const dates: Date[] = [firstDueDate];
  let current = firstDueDate;
  for (let i = 1; i < installmentCount; i++) {
    switch (paymentType) {
      case "daily": {
        let next = addDays(current, 1);
        // Pula domingos (getDay: 0 = domingo)
        while (next.getDay() === 0) {
          next = addDays(next, 1);
        }
        current = next;
        dates.push(current);
        break;
      }
      case "weekly":
        // Sempre o mesmo dia da semana
        current = addWeeks(current, 1);
        dates.push(current);
        break;
      case "biweekly":
        // 15 dias
        current = addDays(current, 15);
        dates.push(current);
        break;
      case "monthly":
        // Mesmo dia do próximo mês
        current = addMonths(firstDueDate, i);
        dates.push(current);
        break;
    }
  }
  return dates;
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

/**
 * Calculate fractional installment progress from remaining_balance (single source of truth).
 * Returns { totalPaid, fractionalProgress, progressFormatted, progressPercent }
 */
export function calculateLoanProgress(params: {
  totalAmount: number;
  remainingBalance: number;
  installmentCount: number;
}) {
  const { totalAmount, remainingBalance, installmentCount } = params;
  const totalPaid = Math.max(0, totalAmount - remainingBalance);
  const installmentValue = installmentCount > 0 ? totalAmount / installmentCount : 1;
  const fractionalProgress = totalPaid / installmentValue;
  const progressPercent = installmentCount > 0 ? (fractionalProgress / installmentCount) * 100 : 0;

  // Format: show decimal only if fractional (e.g. 3.5/24, not 3.0/24)
  const progressFormatted = fractionalProgress % 1 === 0
    ? `${fractionalProgress}/${installmentCount}`
    : `${fractionalProgress.toFixed(1)}/${installmentCount}`;

  return { totalPaid, fractionalProgress, progressFormatted, progressPercent: Math.min(progressPercent, 100), installmentValue };
}

export function getStatusColor(status: string): string {
  switch (status) {
    case "paid":
      return "bg-paid text-paid-foreground";
    case "partial":
      return "bg-partial text-partial-foreground";
    case "overdue":
      return "bg-overdue text-overdue-foreground";
    case "due_today":
      return "bg-due-today text-due-today-foreground";
    case "pending":
      return "bg-open text-open-foreground";
    case "cancelled":
    case "renegotiated":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-muted text-muted-foreground";
  }
}

export function getStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "Em Aberto";
    case "due_today":
      return "Vence Hoje";
    case "overdue":
      return "Atrasado";
    case "paid":
      return "Pago";
    case "partial":
      return "Parcial";
    case "open":
      return "Em Aberto";
    case "cancelled":
      return "Cancelado";
    case "renegotiated":
      return "Renegociado";
    default:
      return status;
  }
}

// Compute display status based on installment data
export function getInstallmentDisplayStatus(inst: {
  status: string;
  due_date: string;
  amount: number;
  paid_amount: number;
}): string {
  if (inst.status === "paid") return "paid";
  if (inst.status === "cancelled") return "cancelled";
  if (inst.status === "renegotiated") return "renegotiated";

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(inst.due_date + "T00:00:00");

  // Today's installments always show "Vence Hoje", never overdue
  if (due.getTime() === today.getTime()) return "due_today";

  // Past due date and not fully paid = overdue (even if partial payment was made)
  if (inst.status === "overdue" || due < today) return "overdue";

  if (Number(inst.paid_amount) > 0 && Number(inst.paid_amount) < Number(inst.amount)) return "partial";
  return "pending";
}


export function getLoanStatusColor(status: string): string {
  switch (status) {
    case "paid":
      return "bg-success text-success-foreground";
    case "overdue":
      return "bg-overdue text-overdue-foreground";
    case "open":
      return "bg-primary text-primary-foreground";
    default:
      return "bg-muted text-muted-foreground";
  }
}

export function calculateOverdueDays(
  overdueDate: string,
  paymentType: string
): number {
  return getOverdueDatesList(overdueDate, paymentType).length;
}

export function getOverdueDatesList(
  overdueDate: string,
  paymentType: string
): Date[] {
  const due = new Date(overdueDate + "T12:00:00");
  const today = new Date();
  today.setHours(12, 0, 0, 0);

  if (today <= due) return [];

  const dates: Date[] = [];
  const current = new Date(due);
  current.setDate(current.getDate() + 1);

  while (current <= today) {
    if (paymentType === "daily" && current.getDay() === 0) {
      current.setDate(current.getDate() + 1);
      continue;
    }
    dates.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

// Helper: returns the active loan for a client, or null.
// Used to enforce the "1 active loan per client" rule across the UI.
import { supabase } from "@/integrations/supabase/client";

export async function getActiveLoanForClient(clientId: string) {
  const { data } = await supabase
    .from("loans")
    .select("id, status, total_amount, remaining_balance, loan_date")
    .eq("client_id", clientId)
    .not("status", "in", "(paid,cancelled,renegotiated)")
    .gt("remaining_balance", 0.01)
    .order("loan_date", { ascending: false })
    .limit(1);
  return data && data.length > 0 ? data[0] : null;
}
