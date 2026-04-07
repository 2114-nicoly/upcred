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
