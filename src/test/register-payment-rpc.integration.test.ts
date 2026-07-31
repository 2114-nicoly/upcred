import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";

/**
 * TESTE DE INTEGRAÇÃO REAL da RPC `register_payment_tx`.
 *
 * Este teste NÃO usa mocks: ele conversa com um banco de testes descartável.
 * Ele só roda quando as variáveis abaixo estiverem definidas no ambiente:
 *
 *   TEST_SUPABASE_URL          - URL do projeto de TESTE (nunca produção)
 *   TEST_SUPABASE_SERVICE_KEY  - service role do projeto de TESTE
 *   TEST_WORKER_JWT            - JWT de um trabalhador de teste
 *   TEST_OTHER_WORKER_JWT      - JWT de um trabalhador de OUTRO escopo
 *   TEST_LOAN_ID               - empréstimo de teste (dados fictícios)
 *
 * Sem essas variáveis o bloco é ignorado (skip) e NÃO se pode afirmar que
 * rollback, autorização ou bloqueio de caixa foram comprovados no banco.
 */

const url = process.env.TEST_SUPABASE_URL;
const serviceKey = process.env.TEST_SUPABASE_SERVICE_KEY;
const workerJwt = process.env.TEST_WORKER_JWT;
const otherWorkerJwt = process.env.TEST_OTHER_WORKER_JWT;
const loanId = process.env.TEST_LOAN_ID;

const ready = Boolean(url && serviceKey && workerJwt && otherWorkerJwt && loanId);

const clientWith = (jwt: string) =>
  createClient(url!, serviceKey!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

describe.skipIf(!ready)("register_payment_tx (banco real, ambiente de teste)", () => {
  it("nega pagamento de trabalhador de outro escopo", async () => {
    const sb = clientWith(otherWorkerJwt!);
    const { error } = await sb.rpc("register_payment_tx" as any, {
      p_loan_id: loanId,
      p_amount: 10,
      p_client_id: null,
      p_cash_date: new Date().toISOString().slice(0, 10),
    } as any);
    expect(error?.message ?? "").toContain("access denied");
  });

  it("bloqueia quando não há caixa aberto para o dia/escopo", async () => {
    const sb = clientWith(workerJwt!);
    const { error } = await sb.rpc("register_payment_tx" as any, {
      p_loan_id: loanId,
      p_amount: 10,
      p_client_id: null,
      p_cash_date: "1999-01-01",
    } as any);
    expect(error?.message ?? "").toMatch(/caixa aberto/i);
  });

  it("rollback total: nada é gravado quando a RPC falha", async () => {
    const admin = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    const before = await admin
      .from("cash_movements")
      .select("id", { count: "exact", head: true })
      .eq("loan_id", loanId);

    const sb = clientWith(workerJwt!);
    await sb.rpc("register_payment_tx" as any, {
      p_loan_id: loanId,
      p_amount: 10,
      p_client_id: null,
      p_cash_date: "1999-01-01",
    } as any);

    const after = await admin
      .from("cash_movements")
      .select("id", { count: "exact", head: true })
      .eq("loan_id", loanId);

    expect(after.count).toBe(before.count);
  });
});
