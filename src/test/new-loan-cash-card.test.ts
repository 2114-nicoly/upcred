import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Card "Caixa disponível" do cadastro/renovação: o saldo vem SEMPRE de
 * getCashBalance no escopo do cliente, falha nunca vira R$0 inventado e uma
 * leitura antiga não pode sobreviver à troca de trabalhador.
 */
const SRC = readFileSync(resolve(process.cwd(), "src/pages/NewLoanPage.tsx"), "utf8");

const refreshFn = (() => {
  const start = SRC.indexOf("const refreshAvailableCash");
  expect(start).toBeGreaterThan(-1);
  const end = SRC.indexOf("\n  // Troca de cliente", start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
})();

describe("card Caixa disponível (NewLoanPage)", () => {
  it("lê o saldo de getCashBalance no escopo do cliente", () => {
    expect(refreshFn).toContain("const scope = clientScope;");
    expect(refreshFn).toContain("getCashBalance(scope)");
    expect(refreshFn).toContain("if (!scope) return;");
  });

  it("falha ou linha ausente vira 'unavailable', nunca R$0", () => {
    expect(refreshFn).toContain("Number.isFinite(available)");
    expect(refreshFn).toContain('{ state: "unavailable" }');
    expect(refreshFn).not.toMatch(/available_cash\s*\?\?\s*0/);
    expect(refreshFn).not.toMatch(/available_cash\s*\|\|\s*0/);
  });

  it("descarta leitura do trabalhador anterior quando o escopo muda", () => {
    expect(refreshFn).toContain("if (seq !== cashSeqRef.current) return;");
    expect(SRC).toMatch(/cashSeqRef\.current \+= 1;[\s\S]{0,120}\}, \[clientScope, clientId\]\);/);
  });

  it("valor liberado: renovação usa valorLiberado, novo usa numAmount, importado zero", () => {
    expect(SRC).toContain(
      "const releasedAmount = isOngoing ? 0 : (renewFromLoanId ? valorLiberado : numAmount);",
    );
  });

  it("card aparece antes do campo Valor Emprestado", () => {
    const card = SRC.indexOf("Caixa disponível");
    const field = SRC.indexOf("<Label>Valor Emprestado");
    expect(card).toBeGreaterThan(-1);
    expect(field).toBeGreaterThan(card);
  });

  it("adicionar dinheiro pelo modal existente atualiza o card", () => {
    const uses = SRC.match(/onCashAdded: \(\) => \{[^}]*\}/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const u of uses) {
      expect(u).toContain("scopedCash.refresh()");
      expect(u).toContain("refreshAvailableCash()");
    }
  });
});
