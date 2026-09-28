import { describe, it, expect } from "vitest";
import { normalizeEvent, INCOMPLETE_RECORD_LABEL } from "@/lib/event-record";

const base = { id: "e1", cash_date: "2026-09-28", created_at: "2026-09-28T13:00:00.000Z", worker_id: "w1", admin_id: "a1", client_id: "c1", loan_id: "l1" };
const val = (r: ReturnType<typeof normalizeEvent>, label: string) => r.details.find((d) => d.label === label)?.value;

describe("normalizeEvent", () => {
  it("pagamento parcial mostra cliente e progresso congelado", () => {
    const r = normalizeEvent({ ...base, event_type: "pagamento", amount_in: 50, metadata: {
      client_name: "Ana", payment_amount: 50, remaining_balance_before: 300, remaining_balance_after: 250,
      installment_progress_before: "3/10", installment_progress_after: "3,5/10", progress_units_before: 3, progress_units_after: 3.5,
      installment_amount: 100, total_installments: 10, affected_installments: [] } });
    expect(r.title).toBe("Pagamento parcial");
    expect(r.clientName).toBe("Ana");
    expect(val(r, "Progresso depois")).toBe("3,5/10");
    expect(r.incomplete).toBe(false);
  });

  it("quitação quando saldo depois é zero", () => {
    const r = normalizeEvent({ ...base, event_type: "pagamento", amount_in: 250, origin: "quitacao", metadata: {
      client_name: "Ana", remaining_balance_before: 250, remaining_balance_after: 0,
      installment_progress_before: "7,5/10", installment_progress_after: "10/10" } });
    expect(r.title).toBe("Quitação");
    expect(r.isSettlement).toBe(true);
  });

  it("registro antigo não inventa valores", () => {
    const r = normalizeEvent({ ...base, event_type: "pagamento", amount_in: 100, observation: "Pagamento R$ 325.00", metadata: null });
    expect(r.incomplete).toBe(true);
    expect(val(r, "Saldo antes")).toBeUndefined();
    expect(val(r, "Aviso")).toBe(INCOMPLETE_RECORD_LABEL);
  });

  it("renovação usa só metadata numérico (325.00 nunca vira 32500)", () => {
    const r = normalizeEvent({ ...base, event_type: "renovacao", amount_out: 500,
      observation: "Renovação - Pago: R$ 325.00 | Faltava: R$ 325.00",
      metadata: { renew_paid_amount: "325.00", old_remaining_before: 325, renew_absorbed_amount: 0, renew_additional_cash: 500, principal_amount: 500, total_amount: 600, installments: 20 } });
    expect(val(r, "Valor pago")).toMatch(/325,00/);
    expect(val(r, "Valor pago")).not.toMatch(/32\.500/);
    expect(val(r, "Valor adicional liberado")).toMatch(/500,00/);
  });

  it("renovacao_absorvida é interna e informativa", () => {
    const r = normalizeEvent({ ...base, event_type: "renovacao_absorvida", metadata: { absorbed_amount: 100 } });
    expect(r.internal).toBe(true);
    expect(r.informative).toBe(true);
  });

  it("não pagou usa dados congelados da data", () => {
    const r = normalizeEvent({ ...base, event_type: "nao_pagou", metadata: { expected_amount: 100, due_date: "2026-09-20", overdue_days: 6, reason: "Viajou", installment_number: 4, total_installments: 20 } });
    expect(val(r, "Atraso na data")).toBe("6 dias");
    expect(r.incomplete).toBe(false);
  });

  it("estorno marca resultado e não é pagamento", () => {
    const r = normalizeEvent({ ...base, event_type: "estorno_pagamento", amount_out: 100, metadata: { reverses_event_id: "x", original_type: "pagamento" } });
    expect(r.category).toBe("Estorno");
    expect(val(r, "Ação original")).toBe("Pagamento");
  });
});
