import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { getCloseOriginLabel } from "@/lib/close-origin";

/**
 * v60 — garantia dos fechamentos daqui para frente.
 * Data de corte estrita, fechamento automático obrigatório de qualquer data
 * pendente, pendentes congelados no snapshot, escopo obrigatório e segurança.
 */

const MIG_DIR = resolve(process.cwd(), "supabase/migrations");
const FILES = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
const readAll = (needle: string) =>
  FILES.map((f) => readFileSync(resolve(MIG_DIR, f), "utf8"))
    .filter((sql) => sql.includes(needle))
    .join("\n")
    .replace(/\s+/g, " ");

/** Somente a migration estrita (a mais recente que define a data de corte). */
const STRICT = (() => {
  const file = FILES.filter((f) =>
    readFileSync(resolve(MIG_DIR, f), "utf8").includes("strict_snapshot_from_date"),
  ).pop()!;
  return readFileSync(resolve(MIG_DIR, file), "utf8").replace(/\s+/g, " ");
})();

/** Builder do snapshot completo (pendentes congelados). */
const BUILDER = readAll("'pending_installments', v_pending");

const fnBody = (sql: string, signature: string) => {
  const start = sql.indexOf(`FUNCTION public.${signature}`);
  expect(start).toBeGreaterThan(-1);
  const rest = sql.slice(start);
  const end = rest.indexOf(`REVOKE ALL ON FUNCTION public.${signature}`);
  return end > 0 ? rest.slice(0, end) : rest;
};

describe("1) data de corte", () => {
  it("cria strict_snapshot_from_date com a data atual de São Paulo", () => {
    expect(STRICT).toContain("ADD COLUMN IF NOT EXISTS strict_snapshot_from_date date");
    expect(STRICT).toContain(
      "SET strict_snapshot_from_date = COALESCE( strict_snapshot_from_date, (now() AT TIME ZONE 'America/Sao_Paulo')::date)",
    );
    expect(STRICT).toContain("FUNCTION public.strict_snapshot_from()");
  });

  it("proíbe fechamento legado a partir da data de corte", () => {
    const body = fnBody(STRICT, "_legacy_close_daily_cash(uuid)");
    expect(body).toContain("IF v_strict IS NOT NULL AND dc.cash_date >= v_strict THEN");
    expect(body).toContain(
      "Esta data exige fechamento completo com registro histórico. Histórico incompleto não é permitido.",
    );
  });

  it("não altera registros anteriores à data de corte", () => {
    const body = fnBody(STRICT, "_ensure_daily_cash_closed_strict(date, uuid, uuid)");
    expect(body).toContain("IF v_strict IS NULL OR p_date < v_strict THEN");
    expect(body).toContain("'before_strict_from'");
    const maint = fnBody(STRICT, "auto_close_cash_maintenance()");
    expect(maint).toContain("v_strict IS NOT NULL AND dc.cash_date < v_strict");
  });
});

describe("2) fechamento automático obrigatório", () => {
  const maint = fnBody(STRICT, "auto_close_cash_maintenance()");

  it("roda no servidor a cada 5 minutos, sem usuário logado", () => {
    expect(STRICT).toContain(
      "PERFORM cron.schedule('auto-close-daily-cash', '*/5 * * * *', 'SELECT public.auto_close_cash_maintenance();')",
    );
    expect(maint).not.toContain("auth.uid()");
    expect(STRICT).toContain(
      "GRANT EXECUTE ON FUNCTION public.auto_close_cash_maintenance() TO service_role",
    );
  });

  it("não se limita a ontem: processa toda data pendente em ordem cronológica", () => {
    expect(STRICT).toContain("FUNCTION public._scope_pending_cash_dates(");
    expect(maint).toContain("FROM public._scope_pending_cash_dates(r.worker_id, r.admin_id, v_today)");
    expect(maint).toContain("ORDER BY cash_date");
    expect(maint).not.toContain("v_yesterday");
  });

  it("caixa aberto é fechado e caixa nunca aberto é criado e fechado", () => {
    const body = fnBody(STRICT, "_ensure_daily_cash_closed_strict(date, uuid, uuid)");
    expect(body).toContain("v_origin := 'automatic_not_opened'");
    expect(body).toContain("v_origin := 'automatic_opened'");
    expect(body).toContain("INSERT INTO public.daily_cash (cash_date, worker_id, admin_id, status, opening_balance, user_id)");
    expect(body).toContain("PERFORM public._close_daily_cash_core(");
  });

  it("falha no snapshot mantém o caixa aberto, registra a falha e tenta de novo", () => {
    const body = fnBody(STRICT, "_ensure_daily_cash_closed_strict(date, uuid, uuid)");
    expect(body).toContain("IF NOT public._daily_cash_snapshot_ok(v_id) THEN");
    expect(body).toContain("O fechamento não gerou o registro histórico obrigatório. O caixa continua aberto.");
    expect(maint).toContain("PERFORM public._record_auto_close_failure(d.cash_date, r.worker_id, r.admin_id, NULL, SQLERRM)");
    expect(maint).toContain("PERFORM public._resolve_auto_close_failure(d.cash_date, r.worker_id, r.admin_id)");
  });

  it("atraso de vários dias nunca vira histórico incompleto", () => {
    // após a data de corte o único caminho é o fechamento estrito
    expect(maint).toContain("res := public._ensure_daily_cash_closed_strict(d.cash_date, r.worker_id, r.admin_id)");
    // o modo legado só é usado antes da data de corte
    const legacyLoop = maint.slice(0, maint.indexOf("IF v_strict IS NULL THEN"));
    expect(legacyLoop).toContain("dc.cash_date < v_strict");
  });

  it("uma data pendente bloqueia as datas seguintes do mesmo escopo", () => {
    expect(maint).toContain("EXIT; -- não avança para datas posteriores deste escopo");
  });
});

describe("3) pendentes congelados no fechamento", () => {
  it("congela cliente, parcela, vencimento, valores, atraso, saldo e progresso", () => {
    for (const key of [
      "'client_id', l.client_id",
      "'client_name', COALESCE(c.name, 'Cliente')",
      "'worker_id', l.worker_id",
      "'installment_number', i.number",
      "'installment_amount', i.amount",
      "'paid_amount', COALESCE(i.paid_amount, 0)",
      "'pending_amount', GREATEST(0, i.amount - COALESCE(i.paid_amount,0))",
      "'due_date', i.due_date",
      "'overdue_days', GREATEST(0, (v_date - i.due_date))",
      "'loan_remaining_balance', l.remaining_balance",
      "'progress_at_close', public._fmt_progress(",
      "'status', 'Pendente no fechamento'",
    ]) {
      expect(BUILDER).toContain(key.replace(/\s+/g, " "));
    }
  });

  it("cliente pago, marcado como não pagou ou com outra ação válida não é pendente", () => {
    expect(BUILDER).toContain(
      "de.event_type IN ('pagamento','recebimento_multa','nao_pagou','renovacao','renegociacao','quitacao','emprestimo_novo')",
    );
    expect(BUILDER).toContain("FROM public.not_paid_marks nm WHERE nm.mark_date = v_date AND nm.loan_id = l.id");
  });

  it("cliente sem nenhuma ação com parcela vencida ou vencendo aparece como pendente", () => {
    expect(BUILDER).toContain("i2.status IN ('pending','partial','overdue')");
    expect(BUILDER).toContain("i2.due_date <= v_date");
  });

  it("sem pendentes salva array vazio e o array é obrigatório", () => {
    expect(BUILDER).toContain("COALESCE(jsonb_agg(p ORDER BY p->>'due_date'), '[]'::jsonb) INTO v_pending");
    expect(BUILDER).toContain("jsonb_typeof(v_payload->'pending_installments') <> 'array'");
  });

  it("manual e automático usam o mesmo núcleo de fechamento", () => {
    const body = fnBody(STRICT, "_ensure_daily_cash_closed_strict(date, uuid, uuid)");
    expect(body).toContain("public._close_daily_cash_core(");
    expect(readAll("close_daily_cash_with_snapshot")).toContain("_close_daily_cash_core");
  });
});

describe("4) exibição dos caixas fechados", () => {
  it("cada origem tem o rótulo padronizado", () => {
    expect(getCloseOriginLabel("manual")).toBe("Fechado manualmente");
    expect(getCloseOriginLabel("automatic_opened")).toBe("Fechado automaticamente");
    expect(getCloseOriginLabel("automatic_not_opened")).toBe(
      "Caixa não foi aberto e foi fechado automaticamente",
    );
  });

  it("o histórico expõe a origem do fechamento do próprio caixa", () => {
    const hook = readFileSync(resolve(process.cwd(), "src/hooks/useMovementDays.ts"), "utf8");
    expect(hook).toContain("closeOrigin: cash?.close_origin ?? null");
    const page = readFileSync(resolve(process.cwd(), "src/pages/DailyCashHistoryPage.tsx"), "utf8");
    expect(page).toContain("getCloseOriginLabel(day.closeOrigin)");
  });
});

describe("5) escopo obrigatório", () => {
  it("as rotinas usam sempre cash_date + worker_id + admin_id", () => {
    const strictFn = fnBody(STRICT, "_ensure_daily_cash_closed_strict(date, uuid, uuid)");
    expect(strictFn).toContain(
      "WHERE cash_date = p_date AND admin_id = p_admin_id AND worker_id IS NOT DISTINCT FROM p_worker_id",
    );
    expect(STRICT).toContain(
      "WHERE dc.cash_date < p_before AND dc.admin_id = p_admin AND dc.worker_id IS NOT DISTINCT FROM p_worker",
    );
  });

  it("trabalhador de outra empresa é recusado", () => {
    const strictFn = fnBody(STRICT, "_ensure_daily_cash_closed_strict(date, uuid, uuid)");
    expect(strictFn).toContain("IF v_worker_admin IS NULL OR v_worker_admin IS DISTINCT FROM p_admin_id THEN");
    expect(strictFn).toContain("Trabalhador não pertence a esta empresa. O fechamento foi cancelado.");
  });

  it("administrador não abre caixa de trabalhador de outra empresa", () => {
    const open = fnBody(STRICT, "open_daily_cash(p_cash_date date, p_worker_id uuid DEFAULT NULL::uuid)");
    expect(open).toContain("IF NOT v_is_super AND v_target_worker_admin IS DISTINCT FROM v_caller_admin THEN");
    expect(open).toContain("trabalhador não pertence à sua equipe");
  });
});

describe("6) abertura do caixa", () => {
  const open = fnBody(STRICT, "open_daily_cash(p_cash_date date, p_worker_id uuid DEFAULT NULL::uuid)");

  it("data futura é bloqueada e data antiga exige reabertura", () => {
    expect(open).toContain("Não é permitido abrir caixa em data futura. Abra o caixa na própria data.");
    expect(open).toContain("Não é permitido abrir um caixa antigo. Utilize o processo de solicitação de reabertura.");
  });

  it("caixa aberto retorna o existente e caixa fechado exige reabertura", () => {
    expect(open).toContain("IF v_status = 'open' THEN RETURN v_id;");
    expect(open).toContain("O caixa de hoje já foi fechado. Solicite a reabertura para voltar a movimentar.");
  });

  it("caixa cancelado ou anulado pode ser reativado", () => {
    expect(open).toContain("IF v_status IN ('cancelled', 'cancelled_empty', 'void') THEN");
  });

  it("verifica TODOS os bloqueios anteriores, não apenas um", () => {
    expect(open).toContain("v_pending := public._scope_oldest_open_cash_date(v_worker, v_admin, v_today)");
    expect(open).toContain("FROM public._scope_pending_cash_dates(v_worker, v_admin, v_today)");
    expect(open).toContain("FROM public.auto_close_failures f WHERE f.resolved_at IS NULL");
    expect(open).toContain(
      "O caixa de % ainda está pendente e não pôde ser finalizado automaticamente. O caixa de hoje não foi aberto. Motivo: %",
    );
  });
});

describe("7) segurança das funções internas", () => {
  it("o builder do snapshot não pode ser chamado por usuário autenticado", () => {
    expect(STRICT).toContain(
      "REVOKE ALL ON FUNCTION public.build_daily_cash_snapshot_v2(uuid) FROM PUBLIC, anon, authenticated",
    );
    expect(STRICT).toContain(
      "GRANT EXECUTE ON FUNCTION public.build_daily_cash_snapshot_v2(uuid) TO service_role",
    );
    expect(STRICT).toContain(
      "REVOKE ALL ON FUNCTION public.build_daily_cash_snapshot_v2_legacy(uuid) FROM PUBLIC, anon, authenticated",
    );
  });

  it("as rotinas internas de fechamento são exclusivas do service_role", () => {
    expect(STRICT).toContain(
      "REVOKE ALL ON FUNCTION public._ensure_daily_cash_closed_strict(date, uuid, uuid) FROM PUBLIC, anon, authenticated",
    );
    expect(STRICT).toContain(
      "REVOKE ALL ON FUNCTION public._legacy_close_daily_cash(uuid) FROM PUBLIC, anon, authenticated",
    );
  });

  it("o frontend nunca chama o builder diretamente", () => {
    const src = readdirSync(resolve(process.cwd(), "src/lib"))
      .map((f) => readFileSync(resolve(process.cwd(), "src/lib", f), "utf8"))
      .join("\n");
    expect(src).not.toContain('rpc("build_daily_cash_snapshot_v2');
  });
});

describe("8) dia fechado sem snapshot válido", () => {
  it("valida snapshot completo com escopo e pendentes", () => {
    expect(STRICT).toContain("FUNCTION public._daily_cash_snapshot_ok(p_daily_cash_id uuid)");
    expect(STRICT).toContain("(s.payload->>'snapshot_kind') IS DISTINCT FROM 'legacy_incomplete'");
    expect(STRICT).toContain("jsonb_typeof(s.payload->'pending_installments') = 'array'");
    expect(STRICT).toContain("(s.payload->'scope'->>'admin_id') IS NOT NULL");
  });

  it("sem fallback com dados atuais: o caixa volta para aberto e refaz o fechamento", () => {
    const body = fnBody(STRICT, "_ensure_daily_cash_closed_strict(date, uuid, uuid)");
    expect(body).toContain("IF public._daily_cash_snapshot_ok(v_id) THEN");
    expect(body).toContain("SET status = 'open', closed_at = NULL, closed_by = NULL,");
    expect(body).toContain("v_status := 'open';");
  });
});
