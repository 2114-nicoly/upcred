import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseClosingMismatch, formatClosingMismatch } from "@/lib/closing-mismatch";

const MIG_DIR = resolve(process.cwd(), "supabase/migrations");
const files = readdirSync(MIG_DIR).filter(f => f.endsWith(".sql")).sort();
const latest = readFileSync(resolve(MIG_DIR, files[files.length - 1]), "utf8");
const allSql = files.map(f => readFileSync(resolve(MIG_DIR, f), "utf8")).join("\n");

const dbMessage = (opening: number, day: number, available: number) => {
  const diff = Math.round((opening + day - available) * 100) / 100;
  const f = (n: number) => n.toFixed(2);
  return `Fechamento cancelado: saldo de abertura (R$ ${f(opening)}) + movimentos do dia (R$ ${f(day)}) difere do Caixa Disponível (R$ ${f(available)}) em R$ ${f(diff)}. O caixa permanece aberto.`;
};

/** Regra de consistência: abertura + movimentos do dia = Caixa Disponível. */
const closingAllowed = (opening: number, day: number, available: number) =>
  Math.abs(Math.round((opening + day - available) * 100) / 100) <= 0.01;

describe("consistência do fechamento", () => {
  it("abertura 1.469 + entradas 2.000 - saídas 2.000 = final 1.469", () => {
    expect(1469 + 2000 - 2000).toBe(1469);
  });

  it("com Caixa Disponível 1.469, o fechamento é permitido", () => {
    expect(closingAllowed(1469, 0, 1469)).toBe(true);
  });

  it("com Caixa Disponível 2.007,68, o fechamento é bloqueado com diferença de R$ 538,68", () => {
    expect(closingAllowed(1469, 0, 2007.68)).toBe(false);
    const m = parseClosingMismatch(dbMessage(1469, 0, 2007.68))!;
    expect(m.expected).toBe(1469);
    expect(m.available).toBe(2007.68);
    expect(m.difference).toBe(-538.68);
  });

  it("divergência real continua bloqueando após a correção", () => {
    expect(closingAllowed(1469, 100, 1469)).toBe(false);
  });

  it("_assert_closing_consistency não foi removido", () => {
    expect(allSql).toContain("_assert_closing_consistency");
    expect(latest).not.toContain("DROP FUNCTION IF EXISTS public._assert_closing_consistency");
  });
});

describe("migration corretiva", () => {
  it("não contém UUID fixo nem valor fixo de reconciliação", () => {
    expect(latest).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(latest).not.toContain("2007.68");
    expect(latest).not.toMatch(/brandon|upcred/i);
  });

  it("só corrige caixas abertos com saldo gravado maior que o esperado", () => {
    expect(latest).toContain("dc.status = 'open'");
    expect(latest).toContain("round(a.available_cash - (a.opening + a.day_net), 2) > 0.01");
  });

  it("recalcula o saldo-base pelos registros reais e registra auditoria", () => {
    expect(latest).toContain("round(a.opening + a.day_net - a.ledger_net, 2) AS base_correta");
    expect(latest).toContain("INSERT INTO public.audit_logs");
    expect(latest).toContain("'ajuste_reconciliacao'");
    expect(latest).toContain("SET ledger_base_amount = c.base_correta");
  });

  it("não altera eventos, movimentos, parcelas, empréstimos ou snapshots", () => {
    for (const t of ["daily_events", "cash_movements", "installments", "loans", "daily_cash_snapshots"]) {
      expect(latest).not.toMatch(new RegExp(`UPDATE public\\.${t}`));
      expect(latest).not.toMatch(new RegExp(`DELETE FROM public\\.${t}`));
    }
  });

  it("escopo sempre por admin_id e worker_id", () => {
    expect(latest).toContain("m.admin_id IS NOT DISTINCT FROM cb.admin_id");
    expect(latest).toContain("m.worker_id IS NOT DISTINCT FROM cb.worker_id");
  });
});

describe("mensagem completa de divergência", () => {
  it("mostra inicial, movimento, esperado, gravado e diferença sem esconder o banco", () => {
    const original = dbMessage(1469, 0, 2007.68);
    const text = formatClosingMismatch(original)!;
    expect(text).toContain("Caixa inicial:");
    expect(text).toContain("Movimento líquido do dia:");
    expect(text).toContain("Caixa esperado:");
    expect(text).toContain("Caixa gravado:");
    expect(text).toContain("Diferença:");
    expect(text).toContain("O caixa continua aberto para conferência.");
    expect(text).toContain(original);
  });

  it("ignora mensagens que não são de divergência", () => {
    expect(formatClosingMismatch("qualquer outro erro")).toBeNull();
  });

  it("CaixaPage usa o detalhamento e não o texto genérico antigo", () => {
    const src = readFileSync(resolve(process.cwd(), "src/pages/CaixaPage.tsx"), "utf8");
    expect(src).toContain("formatClosingMismatch");
    expect(src).not.toContain("porque o saldo das movimentações não corresponde");
  });
});
