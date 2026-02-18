import { addDays, addWeeks, addMonths } from "date-fns";

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
        // Pula domingos (0 = domingo)
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

export function getStatusColor(status: string): string {
  switch (status) {
    case "paid":
      return "bg-success text-success-foreground";
    case "overdue":
      return "bg-overdue text-overdue-foreground";
    case "pending":
      return "bg-warning text-warning-foreground";
    default:
      return "bg-muted text-muted-foreground";
  }
}

export function getStatusLabel(status: string): string {
  switch (status) {
    case "open":
      return "Em Aberto";
    case "overdue":
      return "Atrasado";
    case "paid":
      return "Quitado";
    case "pending":
      return "Em Aberto";
    default:
      return status;
  }
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
  const due = new Date(overdueDate + "T12:00:00");
  const today = new Date();
  today.setHours(12, 0, 0, 0);

  if (today <= due) return 0;

  let days = 0;
  const current = new Date(due);
  current.setDate(current.getDate() + 1);

  while (current <= today) {
    // Para diárias, domingo não conta
    if (paymentType === "daily" && current.getDay() === 0) {
      current.setDate(current.getDate() + 1);
      continue;
    }
    days++;
    current.setDate(current.getDate() + 1);
  }

  return days;
}
