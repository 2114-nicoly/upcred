import { supabase } from "@/integrations/supabase/client";

export type DailyEventType =
  | "pagamento"
  | "nao_pagou"
  | "renovacao"
  | "emprestimo_novo"
  | "saida"
  | "entrada_manual"
  | "saida_manual"
  | "ajuste_manual"
  | "recebimento_multa";

export type DailyEvent = {
  id: string;
  cash_date: string;
  event_type: string;
  client_id: string | null;
  loan_id: string | null;
  installment_id: string | null;
  amount_in: number;
  amount_out: number;
  observation: string | null;
  origin: string | null;
  created_at: string;
};

export async function createDailyEvent(event: {
  cash_date: string;
  event_type: DailyEventType;
  client_id?: string | null;
  loan_id?: string | null;
  installment_id?: string | null;
  amount_in?: number;
  amount_out?: number;
  observation?: string | null;
  origin?: string;
}) {
  const { data, error } = await supabase.from("daily_events" as any).insert({
    cash_date: event.cash_date,
    event_type: event.event_type,
    client_id: event.client_id || null,
    loan_id: event.loan_id || null,
    installment_id: event.installment_id || null,
    amount_in: event.amount_in ?? 0,
    amount_out: event.amount_out ?? 0,
    observation: event.observation || null,
    origin: event.origin || "rota",
  }).select().single();
  if (error) console.error("Error creating daily event:", error);
  return data as unknown as DailyEvent | null;
}

export async function getDailyEvents(cashDate: string): Promise<DailyEvent[]> {
  const { data } = await (supabase.from("daily_events" as any)
    .select("*")
    .eq("cash_date", cashDate)
    .order("created_at", { ascending: false }) as any);
  return (data as unknown as DailyEvent[]) || [];
}

export async function deleteDailyEvent(id: string) {
  await supabase.from("daily_events" as any).delete().eq("id", id);
}

/**
 * Undo a daily event: reverses the financial impact based on event type.
 * - pagamento/recebimento_multa: reverts installment paid_amount, cash_balance, cash_movements
 * - nao_pagou: removes not_paid_mark
 * - entrada_manual/saida_manual/ajuste_manual: reverts cash_balance and cash_movements
 * - emprestimo_novo/renovacao: complex - only removes the event record
 */
export async function undoDailyEvent(event: DailyEvent) {
  const { recalculateCashBalanceFromLedger } = await import("@/lib/cash-utils");
  const { recalculateInstallments } = await import("@/lib/payment-utils");

  if (event.event_type === "pagamento") {
    if (event.loan_id) {
      // Find cash_movements for this loan on this date
      const { data: movements } = await supabase.from("cash_movements")
        .select("id, amount, installment_id")
        .eq("loan_id", event.loan_id)
        .eq("cash_date", event.cash_date)
        .eq("type", "recebimento_normal");

      const totalReversed = (movements || []).reduce((s: number, m: any) => s + Number(m.amount), 0);

      // Delete cash_movements
      for (const mov of (movements || [])) {
        await supabase.from("cash_movements").delete().eq("id", mov.id);
      }

      // Reverse remaining_balance via RPC
      if (totalReversed > 0) {
        await supabase.rpc("reverse_loan_payment", {
          p_loan_id: event.loan_id,
          p_amount: totalReversed,
        });
      }

      // Recalculate installment distribution from remaining_balance
      await recalculateInstallments(event.loan_id);
    }
    await recalculateCashBalanceFromLedger();
  } else if (event.event_type === "recebimento_multa") {
    if (event.loan_id) {
      // Revert penalty installment
      const { data: penaltyInsts } = await supabase.from("installments")
        .select("id, amount, paid_amount")
        .eq("loan_id", event.loan_id).eq("is_penalty", true);
      for (const pi of (penaltyInsts || [])) {
        const newPaid = Math.max(0, Number(pi.paid_amount) - Number(event.amount_in));
        await supabase.from("installments").update({
          paid_amount: newPaid,
          status: newPaid < Number(pi.amount) - 0.01 ? "pending" : "paid",
          paid_at: newPaid < Number(pi.amount) - 0.01 ? null : undefined,
        }).eq("id", pi.id);
      }
      // Delete cash_movement
      await supabase.from("cash_movements").delete()
        .eq("loan_id", event.loan_id)
        .eq("cash_date", event.cash_date)
        .eq("type", "recebimento_multa");
    }
    await recalculateCashBalanceFromLedger();
  } else if (event.event_type === "nao_pagou") {
    // Remove not_paid_mark
    if (event.installment_id) {
      await supabase.from("not_paid_marks").delete()
        .eq("installment_id", event.installment_id)
        .eq("mark_date", event.cash_date);
    }
  } else if (event.event_type === "entrada_manual" || event.event_type === "saida_manual" || event.event_type === "ajuste_manual") {
    // Revert cash balance
    const revertIn = -Number(event.amount_in);
    const revertOut = Number(event.amount_out);
    await updateCashBalance({ available_cash: revertIn + revertOut });
    // Delete cash_movement
    await supabase.from("cash_movements").delete()
      .eq("type", event.event_type)
      .eq("cash_date", event.cash_date);
  }

  // Always delete the daily_event record
  await deleteDailyEvent(event.id);
}

export async function getDailyEventsByType(cashDate: string, eventType: string): Promise<DailyEvent[]> {
  const { data } = await (supabase.from("daily_events" as any)
    .select("*")
    .eq("cash_date", cashDate)
    .eq("event_type", eventType)
    .order("created_at", { ascending: false }) as any);
  return (data as unknown as DailyEvent[]) || [];
}

export function getEventTypeLabel(type: string): string {
  switch (type) {
    case "pagamento": return "Pagamento";
    case "nao_pagou": return "Não Pagou";
    case "renovacao": return "Renovação";
    case "emprestimo_novo": return "Novo Empréstimo";
    case "saida": return "Saída";
    case "entrada_manual": return "Entrada Manual";
    case "saida_manual": return "Saída Manual";
    case "ajuste_manual": return "Ajuste Manual";
    case "recebimento_multa": return "Multa Recebida";
    default: return type;
  }
}

export function getEventTypeColor(type: string): string {
  switch (type) {
    case "pagamento": return "text-success";
    case "nao_pagou": return "text-destructive";
    case "renovacao": return "text-primary";
    case "emprestimo_novo": return "text-primary";
    case "saida": return "text-destructive";
    case "entrada_manual": return "text-success";
    case "saida_manual": return "text-destructive";
    case "ajuste_manual": return "text-primary";
    case "recebimento_multa": return "text-warning";
    default: return "text-muted-foreground";
  }
}
