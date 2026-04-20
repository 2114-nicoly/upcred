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
 * - pagamento/recebimento_multa: reverts via RPC reverse_loan_payment + recalculates installments
 * - nao_pagou: removes not_paid_mark
 * - entrada_manual/saida_manual/ajuste_manual: deletes movement and recalculates cash from ledger
 * - emprestimo_novo/renovacao: BLOCKED — must be undone manually (too complex/risky)
 *
 * Throws an Error with a user-friendly message when the event cannot be undone safely.
 */
export async function undoDailyEvent(event: DailyEvent) {
  // Block undo for new loans and renewals — these create downstream state
  // (installments, balances, possibly closing of previous loan) that cannot
  // be safely reversed without manual review.
  if (event.event_type === "emprestimo_novo") {
    throw new Error(
      "Não é possível desfazer um novo empréstimo automaticamente. Exclua o empréstimo na tela de detalhes do cliente."
    );
  }
  if (event.event_type === "renovacao") {
    throw new Error(
      "Não é possível desfazer uma renovação automaticamente. Exclua o novo empréstimo manualmente — o anterior ficará encerrado."
    );
  }

  const { recalculateCashBalanceFromLedger } = await import("@/lib/cash-utils");
  const { recalculateInstallments } = await import("@/lib/payment-utils");

  if (event.event_type === "pagamento") {
    if (event.loan_id) {
      const { data: movements } = await supabase.from("cash_movements")
        .select("id, amount, installment_id")
        .eq("loan_id", event.loan_id)
        .eq("cash_date", event.cash_date)
        .eq("type", "recebimento_normal");

      const totalReversed = (movements || []).reduce((s: number, m: any) => s + Number(m.amount), 0);

      for (const mov of (movements || [])) {
        await supabase.from("cash_movements").delete().eq("id", mov.id);
      }

      if (totalReversed > 0) {
        await supabase.rpc("reverse_loan_payment", {
          p_loan_id: event.loan_id,
          p_amount: totalReversed,
        });
      }

      await recalculateInstallments(event.loan_id);
    }
    await recalculateCashBalanceFromLedger();
  } else if (event.event_type === "recebimento_multa") {
    if (event.loan_id) {
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
      await supabase.from("cash_movements").delete()
        .eq("loan_id", event.loan_id)
        .eq("cash_date", event.cash_date)
        .eq("type", "recebimento_multa");
    }
    await recalculateCashBalanceFromLedger();
  } else if (event.event_type === "nao_pagou") {
    if (event.installment_id) {
      await supabase.from("not_paid_marks").delete()
        .eq("installment_id", event.installment_id)
        .eq("mark_date", event.cash_date);
    }
  } else if (
    event.event_type === "entrada_manual" ||
    event.event_type === "saida_manual" ||
    event.event_type === "ajuste_manual"
  ) {
    await supabase.from("cash_movements").delete()
      .eq("type", event.event_type)
      .eq("cash_date", event.cash_date);
    await recalculateCashBalanceFromLedger();
  }

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
