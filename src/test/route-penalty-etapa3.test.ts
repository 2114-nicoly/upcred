import { describe, it, expect } from "vitest";
import { computeDailyTotals } from "@/lib/daily-totals";
import { normalizeEvent } from "@/lib/event-record";

const ev = (o: any) => ({ id: crypto.randomUUID(), cash_date: "2026-10-01", amount_in: 0, amount_out: 0, reversed_at: null, reverses_event_id: null, metadata: {}, ...o });

describe("Etapa 3 — multa na Rota", () => {
  it("parcela 300 + multa 20 soma sem duplicar", () => {
    const op = crypto.randomUUID();
    const t = computeDailyTotals([
      ev({ event_type: "pagamento", amount_in: 300, metadata: { operation_id: op } }),
      ev({ event_type: "recebimento_multa", amount_in: 20, metadata: { operation_id: op, payment_mode: "regular_and_penalty", regular_amount: 300, penalty_amount: 20, total_received: 320 } }),
    ] as any);
    expect(t.pagamentos).toBe(300);
    expect(t.multas).toBe(20);
    expect(t.entradas).toBe(320);
  });

  it("somente multa 20", () => {
    const t = computeDailyTotals([ev({ event_type: "recebimento_multa", amount_in: 20, metadata: { payment_mode: "penalty_only", penalty_amount: 20 } })] as any);
    expect(t.pagamentos).toBe(0);
    expect(t.multas).toBe(20);
    expect(t.entradas).toBe(20);
  });

  it("estornados com contrapartida não entram em pagamentos/multas", () => {
    const a = ev({ event_type: "recebimento_multa", amount_in: 20, reversed_at: "x" });
    const r = ev({ event_type: "estorno_pagamento", amount_out: 20, reverses_event_id: a.id });
    const t = computeDailyTotals([a, r] as any);
    expect(t.multas).toBe(0);
    expect(t.entradas - t.saidas).toBe(0);
  });

  it("histórico mostra o modo congelado", () => {
    const n = normalizeEvent(ev({ event_type: "recebimento_multa", amount_in: 20, metadata: { client_name: "Ana", payment_mode: "penalty_only", penalty_amount: 20, total_received: 20, remaining_balance_before: 500, remaining_balance_after: 500 } }) as any);
    expect(n.title).toBe("Pagou somente multa");
    const txt = JSON.stringify(n);
    expect(txt).toContain("Parcela permanece em aberto");
    expect(txt).toContain("Ana");
    const n2 = normalizeEvent(ev({ event_type: "recebimento_multa", amount_in: 20, metadata: { payment_mode: "regular_and_penalty", regular_amount: 300, penalty_amount: 20 } }) as any);
    expect(n2.title).toBe("Pagou parcela + multa");
  });
});
