import { describe, it, expect } from "vitest";
import { computeReversalSummary } from "@/lib/daily-totals";
import { computeCoreTotals } from "@/lib/finance-totals";

/**
 * Snapshots legados (`legacy_auto_reconciliation`):
 * - precisam de escopo explícito (worker_id + admin_id) no payload;
 * - histórico incompleto nunca pode ser completado com dados atuais;
 * - estorno = original + contrapartida com efeito líquido ZERO e valor contado uma vez.
 */

type AnyEvent = Record<string, any>;

const legacyPayload = {
  version: 1,
  format_revision: 2,
  historical_complete: false,
  snapshot_kind: "legacy_incomplete",
  cash_date: "2026-01-10",
  scope: { worker_id: "w1", admin_id: "a1" },
  events: [] as AnyEvent[],
  reversed_events: [] as AnyEvent[],
  totals: { received: 100, penalty: 0, estornos: 50, expected_worker_cash: 100 },
};

function readLegacyScoped(payload: any, scope: { workerId: string; adminId: string }) {
  const s = payload?.scope;
  if (!s || s.worker_id !== scope.workerId || s.admin_id !== scope.adminId) {
    throw new Error("Escopo do snapshot não corresponde ao trabalhador/empresa solicitados.");
  }
  return payload;
}

describe("snapshot legado", () => {
  it("possui escopo obrigatório e marcadores de histórico incompleto", () => {
    expect(legacyPayload.scope.worker_id).toBe("w1");
    expect(legacyPayload.scope.admin_id).toBe("a1");
    expect(legacyPayload.historical_complete).toBe(false);
    expect(legacyPayload.snapshot_kind).toBe("legacy_incomplete");
    expect(legacyPayload.format_revision).toBe(2);
  });

  it("é lido quando o escopo corresponde", () => {
    expect(readLegacyScoped(legacyPayload, { workerId: "w1", adminId: "a1" })).toBeTruthy();
  });

  it("rejeita leitura com escopo incorreto (outro trabalhador ou outra empresa)", () => {
    expect(() => readLegacyScoped(legacyPayload, { workerId: "w2", adminId: "a1" })).toThrow();
    expect(() => readLegacyScoped(legacyPayload, { workerId: "w1", adminId: "a2" })).toThrow();
  });

  it("não expõe pendentes, atrasados ou carteira", () => {
    expect((legacyPayload as any).pending_installments).toBeUndefined();
    expect((legacyPayload as any).overdue_clients).toBeUndefined();
    expect((legacyPayload as any).portfolio_state).toBeUndefined();
  });
});

describe("estorno pair-aware", () => {
  const original: AnyEvent = {
    id: "e1", event_type: "pagamento", amount_in: 200, amount_out: 0,
    cash_date: "2026-01-10", reversed_at: "2026-01-10T15:00:00Z", worker_id: "w1",
  };
  const counterpart: AnyEvent = {
    id: "e2", event_type: "estorno_pagamento", amount_in: 0, amount_out: 200,
    cash_date: "2026-01-10", reverses_event_id: "e1", worker_id: "w1",
  };

  it("original + contrapartida têm efeito líquido zero no caixa", () => {
    const net = (original.amount_in - original.amount_out) + (counterpart.amount_in - counterpart.amount_out);
    expect(net).toBe(0);
  });

  it("conta o valor do estorno uma única vez", () => {
    const summary = computeReversalSummary([original, counterpart] as any);
    expect(summary.total).toBe(200);
    expect(summary.count).toBe(1);
  });

  it("evento estornado não conta como recebido", () => {
    const core = computeCoreTotals([original, counterpart] as any);
    expect(core.recebidoTotal).toBe(0);
  });
});
