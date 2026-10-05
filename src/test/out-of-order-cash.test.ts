import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const DIR = resolve(process.cwd(), "supabase/migrations");
const files = readdirSync(DIR).filter(f => f.endsWith(".sql")).sort();
const latest = [...files].reverse()
  .map(f => readFileSync(resolve(DIR, f), "utf8"))
  .find(s => s.includes("FUNCTION public._assert_open_cash_consistency"))!;

/** Modelo do saldo corrente: base + soma líquida do ledger (cada movimento uma vez). */
function ledger(base: number) {
  const mov: { id: string; amount: number; op?: string }[] = [];
  const bal = () => Math.round((base + mov.reduce((s, m) => s + m.amount, 0)) * 100) / 100;
  return {
    add(amount: number, op?: string) {
      if (op && mov.some(m => m.op === op)) return bal(); // operation_id idempotente
      mov.push({ id: String(mov.length), amount, op }); return bal();
    },
    bal,
  };
}

describe("caixa fora da ordem cronológica", () => {
  it("consistência não usa mais reconstrução histórica", () => {
    const body = latest.split("_assert_open_cash_consistency")[1];
    expect(body).not.toContain("_closing_basis");
    expect(body).not.toContain("after_net");
    expect(body).toContain("_cash_ledger_net");
    expect(body).toContain("não existe saldo de caixa");
  });
  it("A–G: cada operação altera o saldo exatamente uma vez", () => {
    const l = ledger(1000);
    expect(l.add(50)).toBe(1050);            // A
    expect(l.add(50, "sab")).toBe(1100);     // B sábado depois do domingo
    expect(l.add(100, "dom")).toBe(1200);    // C
    expect(l.add(-100)).toBe(1100);          // D estorno
    expect(l.add(60, "pm")).toBe(1160);      // E 50 + multa 10
    expect(l.add(-60)).toBe(1100);
    expect(l.add(60, "pm")).toBe(1100 + 0);  // F mesma operation_id não duplica
    expect(l.add(10) + 0).toBe(1110);        // G (serialização por FOR UPDATE no trigger)
  });
});
