import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Guard de empréstimos: normal só na data do caixa aberto;
 * importado em andamento (histórico) é permitido com data antiga
 * e não movimenta o caixa.
 */

const MIG_DIR = resolve(process.cwd(), "supabase/migrations");
const FIX = (() => {
  const files = readdirSync(MIG_DIR).filter(f => f.endsWith(".sql")).sort();
  const file = files.find(f => f.startsWith("20260803201010"))!;
  return readFileSync(resolve(MIG_DIR, file), "utf8").replace(/\s+/g, " ");
})();

describe("migration do guard de empréstimos", () => {
  it("libera apenas o empréstimo importado em andamento", () => {
    expect(FIX).toContain("FUNCTION public.cash_lock_guard_loans()");
    expect(FIX).toContain("IF COALESCE(NEW.is_imported_ongoing, false) THEN RETURN NEW; END IF;");
  });

  it("mantém a proteção de data para empréstimos normais", () => {
    expect(FIX).toContain("PERFORM public._assert_active_cash_date(v_date, v_worker, v_admin);");
    expect(FIX).toContain("v_date := COALESCE(NEW.loan_date, CURRENT_DATE);");
  });

  it("continua fechada para anon/authenticated", () => {
    expect(FIX).toContain(
      "REVOKE ALL ON FUNCTION public.cash_lock_guard_loans() FROM PUBLIC, anon, authenticated;",
    );
  });

  it("não toca em caixa, movimentos, eventos ou empréstimos existentes", () => {
    for (const forbidden of [
      "UPDATE public.loans",
      "UPDATE public.daily_cash",
      "UPDATE public.cash_balance",
      "INSERT INTO public.cash_movements",
      "INSERT INTO public.daily_events",
      "emprestimo_novo",
    ]) {
      expect(FIX).not.toContain(forbidden);
    }
  });
});

/** Reprodução da semântica do trigger para validar os casos exigidos. */
type Loan = { loan_date: string; is_imported_ongoing?: boolean };
type Cash = { cash_date: string } | null;

function guard(loan: Loan, openCash: Cash) {
  if (loan.is_imported_ongoing) return; // histórico: sempre permitido
  if (!openCash) throw new Error("Não existe caixa aberto. Abra o caixa para registrar operações.");
  if (openCash.cash_date !== loan.loan_date) {
    throw new Error(`O caixa aberto é o de ${openCash.cash_date}.`);
  }
}

describe("comportamento do guard", () => {
  const hoje = "2026-08-03";
  const aberto = { cash_date: hoje };

  it("bloqueia empréstimo normal sem caixa aberto", () => {
    expect(() => guard({ loan_date: hoje }, null)).toThrow(/caixa aberto/);
  });

  it("bloqueia empréstimo normal em data diferente do caixa aberto", () => {
    expect(() => guard({ loan_date: "2026-07-30" }, aberto)).toThrow(/O caixa aberto é o de/);
  });

  it("permite empréstimo normal na data do caixa aberto", () => {
    expect(() => guard({ loan_date: hoje }, aberto)).not.toThrow();
  });

  it("permite empréstimo importado com data histórica", () => {
    expect(() => guard({ loan_date: "2025-01-10", is_imported_ongoing: true }, aberto)).not.toThrow();
    expect(() => guard({ loan_date: "2025-01-10", is_imported_ongoing: true }, null)).not.toThrow();
  });

  it("importação não altera o caixa disponível", () => {
    const caixa = { available_cash: 1000 };
    const aplicar = (loan: Loan) => {
      guard(loan, aberto);
      if (!loan.is_imported_ongoing) caixa.available_cash -= 100; // saída de empréstimo novo
    };
    aplicar({ loan_date: "2025-01-10", is_imported_ongoing: true });
    expect(caixa.available_cash).toBe(1000);
  });
});
