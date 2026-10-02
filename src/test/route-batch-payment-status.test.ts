import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Garante que a RPC de pagamento em lote da Rota do Dia aceita somente
 * empréstimos com status ativo real do sistema ('open' e 'overdue'),
 * rejeitando 'paid', 'cancelled' e 'renegotiated', e que a validação
 * acontece antes de qualquer gravação (nenhum pagamento parcial fica no banco).
 */

const MIG_DIR = resolve(process.cwd(), "supabase/migrations");
const files = readdirSync(MIG_DIR).filter(f => f.endsWith(".sql")).sort();
const allSql = files.map(f => readFileSync(resolve(MIG_DIR, f), "utf8"));

// Migração mais recente que define a função (a correção, não a original).
const migration = [...allSql].reverse().find(s => s.includes("register_route_batch_payments_tx"))!;

const statusCheck = migration.match(/IF v_rec\.loan_status NOT IN \(([^)]*)\)/)?.[1] ?? "";

describe("register_route_batch_payments_tx — status de empréstimo aceito", () => {
  it("aceita 'open' e 'overdue'", () => {
    expect(statusCheck).toContain("'open'");
    expect(statusCheck).toContain("'overdue'");
  });

  it("não usa 'active', que não é status válido de loans", () => {
    expect(statusCheck).not.toContain("'active'");
    expect(migration).not.toMatch(/loan_status NOT IN \('active'/);
  });

  it("rejeita 'paid', 'cancelled' e 'renegotiated'", () => {
    for (const bad of ["'paid'", "'cancelled'", "'renegotiated'"]) {
      expect(statusCheck).not.toContain(bad);
    }
    // A mensagem de erro continua cobrindo qualquer status fora da lista.
    expect(migration).toContain("não está ativo");
  });

  it("valida todos os itens antes de gravar qualquer pagamento", () => {
    const validationLoop = migration.indexOf("FOR v_rec IN");
    const firstRegisterCall = migration.indexOf("public.register_payment_tx(");
    expect(validationLoop).toBeGreaterThan(-1);
    expect(firstRegisterCall).toBeGreaterThan(-1);
    expect(firstRegisterCall).toBeGreaterThan(validationLoop);
    // A checagem de status fica dentro do loop de validação, antes da primeira gravação.
    expect(migration.indexOf("v_rec.loan_status NOT IN")).toBeLessThan(firstRegisterCall);
  });

  it("função transacional: rollback total em falha (plpgsql, sem commits intermediários)", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.register_route_batch_payments_tx");
    expect(migration).not.toMatch(/\bCOMMIT\b/);
    expect(migration).not.toMatch(/\bROLLBACK\b/);
  });

  it("assinatura e permissões preservadas", () => {
    expect(migration).toContain("(p_cash_date date, p_installment_ids uuid[])");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.register_route_batch_payments_tx(date, uuid[]) TO authenticated");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.register_route_batch_payments_tx(date, uuid[]) TO service_role");
  });
});
