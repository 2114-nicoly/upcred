import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Etapa 1 — base transacional do pagamento com multa.
 * Valida a definição SQL das RPCs register_route_payment_with_penalty_tx e
 * reverse_route_payment_with_penalty_tx (migration mais recente que as define).
 */
const MIG_DIR = resolve(process.cwd(), "supabase/migrations");
const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
const sql = [...files]
  .reverse()
  .map((f) => readFileSync(resolve(MIG_DIR, f), "utf8"))
  .find((s) => s.includes("FUNCTION public.register_route_payment_with_penalty_tx"))!;

const fnBody = (name: string) => {
  const start = sql.indexOf(`FUNCTION public.${name}(`);
  const end = sql.indexOf("END $function$", start);
  return sql.slice(start, end);
};
const reg = fnBody("register_route_payment_with_penalty_tx");
const rev = fnBody("reverse_route_payment_with_penalty_tx");

describe("register_route_payment_with_penalty_tx", () => {
  it("existe na migration", () => {
    expect(sql).toBeTruthy();
    expect(reg.length).toBeGreaterThan(100);
  });

  it("aceita somente os dois modos e valida valores", () => {
    expect(reg).toContain("NOT IN ('regular_and_penalty','penalty_only')");
    expect(reg).toMatch(/p_penalty_amount IS NULL OR p_penalty_amount <= 0/);
    expect(reg).toMatch(/p_regular_amount IS NULL OR p_regular_amount < 0/);
    expect(reg).toMatch(/p_mode = 'regular_and_penalty' AND p_regular_amount <= 0/);
    expect(reg).toMatch(/p_mode = 'penalty_only' AND p_regular_amount <> 0/);
  });

  it("parcela + multa: reutiliza register_payment_tx na mesma transação", () => {
    expect(reg).toMatch(/IF p_mode = 'regular_and_penalty' THEN\s+v_reg_result := public\.register_payment_tx\(/);
  });

  it("somente multa: não chama register_payment_tx e não mexe no saldo do empréstimo", () => {
    expect((reg.match(/register_payment_tx\(/g) ?? []).length).toBe(1);
    expect(reg).not.toMatch(/UPDATE public\.loans/);
    expect(reg).not.toMatch(/due_date\s*=/);
  });

  it("operation_id duplicado é bloqueado (lock + verificação + índice único)", () => {
    expect(reg).toContain("pg_advisory_xact_lock");
    expect(reg).toContain("já foi usado com dados diferentes");
    expect(sql).toMatch(/CREATE UNIQUE INDEX[\s\S]*operation_id/);
  });

  it("exige caixa aberto no escopo exato do empréstimo", () => {
    expect(reg).toMatch(/dc\.worker_id = v_loan\.worker_id\s+AND dc\.admin_id = v_loan\.admin_id AND dc\.status = 'open'/);
  });

  it("escopo incorreto recebe access denied e escopo vem do banco", () => {
    expect(reg).toMatch(/v_loan\.worker_id <> v_caller_worker[\s\S]*access denied/);
    expect(reg).toMatch(/v_loan\.admin_id <> v_caller_admin/);
    expect(reg).toContain("v_loan.status NOT IN ('open','overdue')");
  });

  it("bloqueia parcela, empréstimo e cash_balance", () => {
    expect(reg).toMatch(/FROM public\.installments WHERE id = p_installment_id FOR UPDATE/);
    expect(reg).toMatch(/FROM public\.loans WHERE id = v_inst\.loan_id FOR UPDATE/);
    expect(reg).toMatch(/FROM public\.cash_balance[\s\S]*FOR UPDATE/);
  });

  it("rollback completo: falhas usam RAISE (sem EXCEPTION handler que engula erros)", () => {
    expect(reg).not.toMatch(/EXCEPTION\s+WHEN/);
    expect(reg).toContain("ultrapassaria o valor da multa");
  });

  it("registra a multa no sistema existente e só reduz penalty_receivable pela multa antiga", () => {
    expect(reg).toContain("'recebimento_multa'");
    expect(reg).toContain("INSERT INTO public.penalties");
    expect(reg).toMatch(/penalty_receivable = penalty_receivable - v_used_old/);
    expect(reg).toContain("UPDATE public.cash_movements SET daily_event_id = v_event_id");
    expect(reg).toContain("log_audit");
  });

  it("congela metadata exigida", () => {
    for (const k of [
      "operation_id", "payment_mode", "client_name", "installment_number", "regular_amount",
      "penalty_amount", "total_received", "remaining_balance_before", "remaining_balance_after",
      "installment_before", "installment_after", "penalty_balance_before", "penalty_balance_after",
      "penalty_used_existing", "penalty_created_paid", "regular_movement_id", "regular_event_id",
    ]) expect(reg).toContain(`'${k}'`);
  });
});

describe("reverse_route_payment_with_penalty_tx", () => {
  it("estorno dos dois modos (parcela via reverse_cash_movement_tx)", () => {
    expect(rev).toMatch(/IF v_mode = 'regular_and_penalty' THEN\s+v_reg_rev := public\.reverse_cash_movement_tx\(/);
    expect(rev).toContain("v_mode <> 'penalty_only'");
  });

  it("multa criada e paga é cancelada, não fica pendente", () => {
    expect(rev).toMatch(/UPDATE public\.penalties\s+SET paid = false, paid_amount = 0, paid_at = NULL,\s+cancelled_at = now\(\)/);
    expect(rev).toMatch(/v_new_amount := round\(v_pen_inst\.amount - v_new_part, 2\)/);
    expect(rev).toContain("v_new_status := 'cancelled'");
  });

  it("restaura multa antiga e penalty_receivable", () => {
    expect(rev).toContain("penalty_rows_applied");
    expect(rev).toMatch(/penalty_receivable = penalty_receivable \+ v_used_old/);
  });

  it("bloqueia operação posterior, estorno repetido e caixa fechado", () => {
    expect(rev).toContain("existe uma operação posterior");
    expect(rev).toContain("já foi estornada");
    expect(rev).toMatch(/dc\.status = 'open'/);
    expect(rev).not.toMatch(/EXCEPTION\s+WHEN/);
  });
});

describe("segurança", () => {
  it("SECURITY DEFINER, search_path e grants restritos", () => {
    expect(reg).toContain("SECURITY DEFINER");
    expect(rev).toContain("SECURITY DEFINER");
    expect((sql.match(/SET search_path TO 'public'/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.register_route_payment_with_penalty_tx[^;]*FROM PUBLIC, anon/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.reverse_route_payment_with_penalty_tx[^;]*FROM PUBLIC, anon/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.register_route_payment_with_penalty_tx[^;]*TO authenticated, service_role/);
  });
});
