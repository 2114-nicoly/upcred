import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { computeDailyTotals } from "@/lib/daily-totals";
import { computeCoreTotals } from "@/lib/finance-totals";

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const migrationsDir = path.join(root, "supabase/migrations");
const reversalMigration = fs
  .readdirSync(migrationsDir)
  .map((f) => fs.readFileSync(path.join(migrationsDir, f), "utf8"))
  .filter((sql) => sql.includes("reverse_cash_movement_tx"))
  .join("\n");

describe("reverse_cash_movement_tx — RPC transacional", () => {
  it("existe em uma migration", () => {
    expect(reversalMigration.length).toBeGreaterThan(0);
  });

  it("bloqueia todas as linhas envolvidas com FOR UPDATE", () => {
    expect(reversalMigration).toMatch(/FOR UPDATE/i);
    const locks = reversalMigration.match(/FOR UPDATE/gi) || [];
    expect(locks.length).toBeGreaterThanOrEqual(3);
  });

  it("exige motivo com no mínimo 3 caracteres", () => {
    expect(reversalMigration).toMatch(/btrim\(\s*COALESCE\(p_reason/i);
    expect(reversalMigration).toMatch(/length\(v_reason\)\s*<\s*3/i);
  });


  it("exige caixa aberto para o dia da movimentação", () => {
    expect(reversalMigration.toLowerCase()).toContain("daily_cash");
    expect(reversalMigration.toLowerCase()).toMatch(/closed/);
  });

  it("bloqueia estorno de empréstimo, renovação e renegociação", () => {
    expect(reversalMigration).toMatch(/emprestimo/i);
    expect(reversalMigration).toMatch(/renovacao/i);
    expect(reversalMigration).toMatch(/renegociacao/i);
  });

  it("impede estorno duplicado e estorno de contrapartida", () => {
    expect(reversalMigration).toMatch(/reverses_movement_id/);
    expect(reversalMigration).toMatch(/reversed_at/);
  });

  it("valida isolamento por worker_id e admin_id", () => {
    expect(reversalMigration).toMatch(/worker_id/);
    expect(reversalMigration).toMatch(/admin_id/);
  });

  it("preserva original e cria contrapartida vinculada", () => {
    expect(reversalMigration).toMatch(/insert\s+into\s+public\.cash_movements/i);
    expect(reversalMigration).toMatch(/insert\s+into\s+public\.daily_events/i);
    expect(reversalMigration).toMatch(/reverses_event_id/);
    expect(reversalMigration).not.toMatch(/delete\s+from\s+public\.cash_movements/i);
    expect(reversalMigration).not.toMatch(/delete\s+from\s+public\.daily_events/i);
  });

  it("é restrita a usuários autenticados", () => {
    expect(reversalMigration).toMatch(
      /REVOKE ALL ON FUNCTION public\.reverse_cash_movement_tx\(uuid, text\) FROM PUBLIC, anon;/
    );
    expect(reversalMigration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.reverse_cash_movement_tx\(uuid, text\) TO authenticated;/
    );
  });

});

describe("Frontend usa somente a RPC transacional", () => {
  const paymentUtils = read("src/lib/payment-utils.ts");
  const dailyEvents = read("src/lib/daily-events.ts");
  const cashHistory = read("src/pages/CashHistoryPage.tsx");

  it("reversePayment chama reverse_cash_movement_tx", () => {
    expect(paymentUtils).toContain('supabase.rpc("reverse_cash_movement_tx"');
  });

  it("undoDailyEvent chama reverse_cash_movement_tx para eventos financeiros", () => {
    expect(dailyEvents).toContain('supabase.rpc("reverse_cash_movement_tx"');
  });

  it("CashHistoryPage não atualiza saldo nem estorna manualmente", () => {
    expect(cashHistory).toContain('supabase.rpc("reverse_cash_movement_tx"');
    expect(cashHistory).not.toContain("updateCashBalance");
    expect(cashHistory).not.toContain("reverseCashMovement");
  });

  it("CashHistoryPage não permite editar o valor da movimentação", () => {
    expect(cashHistory).not.toMatch(/from\("cash_movements"\)\s*\.update/);
    expect(cashHistory).not.toContain("Editar Movimentação");
  });

  it("não há auditoria duplicada de estorno no frontend", () => {
    expect(cashHistory).not.toContain("logReversal");
  });
});

describe("Totais — estorno sem impacto duplo", () => {
  const original = {
    id: "ev-1",
    event_type: "pagamento",
    amount_in: 100,
    amount_out: 0,
    reversed_at: "2026-01-01T10:00:00Z",
    reversal_event_id: "ev-2",
  };
  const counter = {
    id: "ev-2",
    event_type: "estorno_pagamento",
    amount_in: 0,
    amount_out: 100,
    reverses_event_id: "ev-1",
  };

  it("impacto líquido no caixa é zero", () => {
    const t = computeDailyTotals([original, counter], 500);
    expect(t.entradas - t.saidas).toBe(0);
    expect(t.saldoFinalEsperado).toBe(500);
  });

  it("pagamento estornado não conta como recebido", () => {
    const t = computeDailyTotals([original, counter]);
    expect(t.pagamentos).toBe(0);
    expect(t.estornos).toBe(100);
    expect(t.estornosCount).toBe(1);
  });

  it("pagamento válido segue contando normalmente", () => {
    const t = computeDailyTotals([
      { id: "ev-3", event_type: "pagamento", amount_in: 80, amount_out: 0 },
      original,
      counter,
    ]);
    expect(t.pagamentos).toBe(80);
    expect(t.estornos).toBe(100);
  });

  it("estorno legado sem contrapartida é ignorado e sinalizado", () => {
    const t = computeDailyTotals([
      { id: "ev-9", event_type: "pagamento", amount_in: 50, amount_out: 0, reversed_at: "x" },
    ]);
    expect(t.pagamentos).toBe(0);
    expect(t.entradas).toBe(0);
    expect(t.estornosSemContrapartida).toEqual(["ev-9"]);
  });

  it("finance-totals separa estornos do recebido", () => {
    const c = computeCoreTotals([original, counter] as any);
    expect(c.recebidoPrincipal).toBe(0);
    expect(c.recebidoTotal).toBe(0);
    expect(c.estornos).toBe(100);
  });
});
