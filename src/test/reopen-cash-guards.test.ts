import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Reabertura de caixa: só existe um caminho — as RPCs seguras.
 * Nenhuma tela pode alterar daily_cash ou cash_reopen_requests diretamente.
 */

const MIG_DIR = resolve(process.cwd(), "supabase/migrations");
const SRC_DIR = resolve(process.cwd(), "src");

const migration = (() => {
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
  return files
    .map((f) => readFileSync(resolve(MIG_DIR, f), "utf8"))
    .filter((sql) => sql.includes("_reopen_daily_cash_core"))
    .join("\n");
})();

const norm = (s: string) => s.replace(/\s+/g, " ");
const SQL = norm(migration);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}
const SOURCES = walk(SRC_DIR).filter((p) => !p.includes(`${"/"}test${"/"}`));

describe("função interna de reabertura", () => {
  it("existe e é única", () => {
    expect(SQL).toContain("CREATE OR REPLACE FUNCTION public._reopen_daily_cash_core");
  });

  it("bloqueia a linha do caixa e exige status fechado", () => {
    expect(SQL).toContain("FROM public.daily_cash WHERE id = p_daily_cash_id FOR UPDATE");
    expect(SQL).toContain("IF dc.status <> 'closed' THEN RAISE EXCEPTION 'caixa não está fechado'");
  });

  it("valida vínculo entre trabalhador e empresa do caixa", () => {
    expect(SQL).toContain("w.id = dc.worker_id AND w.parent_admin_id = dc.admin_id");
  });

  it("não altera opening_balance, saldos, pagamentos ou parcelas", () => {
    const core = SQL.slice(
      SQL.indexOf("_reopen_daily_cash_core"),
      SQL.indexOf("REVOKE ALL ON FUNCTION public._reopen_daily_cash_core"),
    );
    expect(core).not.toContain("opening_balance =");
    expect(core).not.toContain("cash_balance");
    expect(core).not.toContain("installments");
    expect(core).not.toContain("DELETE FROM public.daily_cash_snapshots");
  });

  it("grava auditoria com escopo completo e request_id", () => {
    expect(SQL).toContain("'reabrir_caixa', 'cash', p_daily_cash_id");
    expect(SQL).toContain("'request_id', p_request_id");
    expect(SQL).toContain("'worker_id', dc.worker_id");
    expect(SQL).toContain("'admin_id', dc.admin_id");
  });

  it("não pode ser executada por anon ou authenticated", () => {
    expect(SQL).toContain(
      "REVOKE ALL ON FUNCTION public._reopen_daily_cash_core(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated",
    );
  });
});

describe("solicitação do trabalhador", () => {
  it("deriva o escopo no banco e exige caixa do próprio trabalhador", () => {
    expect(SQL).toContain("CREATE OR REPLACE FUNCTION public.request_cash_reopen(p_daily_cash_id uuid, p_reason text)");
    expect(SQL).toContain("v_worker := public.get_worker_id(auth.uid())");
    expect(SQL).toContain("IF dc.worker_id IS DISTINCT FROM v_worker THEN RAISE EXCEPTION 'caixa fora do seu escopo'");
  });

  it("exige motivo com no mínimo 3 caracteres", () => {
    expect(SQL).toContain("length(trim(p_reason)) < 3");
  });

  it("impede duas solicitações pendentes para o mesmo caixa (clique repetido)", () => {
    expect(SQL).toContain("CREATE UNIQUE INDEX IF NOT EXISTS cash_reopen_requests_pending_uidx");
    expect(SQL).toContain("WHERE status = 'pending' AND daily_cash_id IS NOT NULL");
    expect(SQL).toContain("já existe uma solicitação pendente para este caixa");
  });
});

describe("aprovação e recusa", () => {
  it("bloqueia a solicitação e valida status pending", () => {
    expect(SQL).toContain("FROM public.cash_reopen_requests WHERE id = p_request_id FOR UPDATE");
    expect(SQL).toContain("IF v_req.status <> 'pending' THEN RAISE EXCEPTION 'solicitação já foi respondida'");
  });

  it("Admin A não aprova solicitação/caixa do Admin B", () => {
    expect(SQL).toContain("IF NOT v_is_super AND v_req.admin_id IS DISTINCT FROM v_caller_admin THEN");
    expect(SQL).toContain("AND (v_is_super OR dc.admin_id = v_caller_admin)");
  });

  it("só marca approved depois de reabrir o caixa", () => {
    const approve = SQL.slice(SQL.indexOf("FUNCTION public.approve_cash_reopen_request"));
    const reopenAt = approve.indexOf("PERFORM public._reopen_daily_cash_core");
    const approvedAt = approve.indexOf("SET status = 'approved'");
    expect(reopenAt).toBeGreaterThan(-1);
    expect(approvedAt).toBeGreaterThan(reopenAt);
  });

  it("solicitações antigas exigem exatamente um caixa por data+trabalhador+empresa", () => {
    expect(SQL).toContain("não foi possível identificar o caixa desta solicitação");
    expect(SQL).toContain("IF v_count <> 1 THEN");
  });
});

describe("reabertura direta pelo administrador", () => {
  it("cria solicitação já aprovada e chama a função interna", () => {
    expect(SQL).toContain("CREATE OR REPLACE FUNCTION public.admin_reopen_daily_cash(p_daily_cash_id uuid, p_reason text)");
    expect(SQL).toContain("PERFORM public._reopen_daily_cash_core(p_daily_cash_id, trim(p_reason), v_req_id, auth.uid())");
  });

  it("recusa caixa de outra empresa e reabertura duplicada", () => {
    expect(SQL).toContain("IF NOT v_is_super AND dc.admin_id IS DISTINCT FROM v_caller_admin THEN");
    expect(SQL).toContain("existe uma solicitação pendente para este caixa: aprove ou recuse");
  });
});

describe("permissões", () => {
  it("revoga a RPC antiga de reabertura", () => {
    expect(SQL).toContain("REVOKE ALL ON FUNCTION public.reopen_daily_cash(date, text) FROM PUBLIC, anon, authenticated");
  });

  it("revoga escrita direta em daily_cash e cash_reopen_requests", () => {
    expect(SQL).toContain("REVOKE INSERT, UPDATE, DELETE ON public.cash_reopen_requests FROM authenticated, anon");
    expect(SQL).toContain("REVOKE INSERT, UPDATE, DELETE ON public.daily_cash FROM authenticated, anon");
    expect(SQL).toContain("GRANT SELECT ON public.daily_cash TO authenticated");
  });
});

describe("frontend não faz reabertura direta", () => {
  it("não existe update/insert/delete direto em daily_cash", () => {
    for (const file of SOURCES) {
      const src = readFileSync(file, "utf8");
      const blocks = src.split(/from\("daily_cash"/).slice(1);
      for (const b of blocks) {
        const head = b.slice(0, 200);
        expect(/\.(update|insert|delete|upsert)\(/.test(head), `escrita direta em daily_cash: ${file}`).toBe(false);
      }
    }
  });

  it("não existe insert/update direto em cash_reopen_requests", () => {
    for (const file of SOURCES) {
      const src = readFileSync(file, "utf8");
      const blocks = src.split(/from\("cash_reopen_requests"/).slice(1);
      for (const b of blocks) {
        const head = b.slice(0, 200);
        expect(/\.(update|insert|delete|upsert)\(/.test(head), `escrita direta em cash_reopen_requests: ${file}`).toBe(false);
      }
    }
  });

  it("não chama mais a RPC antiga reopen_daily_cash", () => {
    for (const file of SOURCES) {
      const src = readFileSync(file, "utf8");
      expect(src.includes('rpc("reopen_daily_cash'), `RPC antiga usada em ${file}`).toBe(false);
    }
  });

  it("usa as RPCs seguras", () => {
    const all = SOURCES.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(all).toContain('rpc("request_cash_reopen"');
    expect(all).toContain('rpc("admin_reopen_daily_cash"');
    expect(all).toContain('rpc(rpc as any');
  });
});

describe("snapshots preservados e versionados", () => {
  const versionSql = (() => {
    const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
    return norm(
      files
        .map((f) => readFileSync(resolve(MIG_DIR, f), "utf8"))
        .filter((sql) => sql.includes("close_daily_cash_with_snapshot"))
        .join("\n"),
    );
  })();

  it("novo fechamento cria versão N+1 sem apagar versões anteriores", () => {
    expect(versionSql).toContain("SELECT COALESCE(MAX(version), 0) + 1 INTO v_version FROM public.daily_cash_snapshots");
    expect(versionSql).not.toContain("DELETE FROM public.daily_cash_snapshots");
  });

  it("nova versão carrega o motivo da reabertura", () => {
    expect(versionSql).toContain("reopen_reason");
    expect(versionSql).toContain("al.action_type = 'reabrir_caixa'");
  });
});

describe("concorrência e permissões explícitas", () => {
  const ALL_SQL = (() => {
    const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
    return norm(files.map((f) => readFileSync(resolve(MIG_DIR, f), "utf8")).join("\n"));
  })();

  const lastRequestFn = (() => {
    const marker = "CREATE OR REPLACE FUNCTION public.request_cash_reopen(p_daily_cash_id uuid, p_reason text)";
    const start = ALL_SQL.lastIndexOf(marker);
    return ALL_SQL.slice(start, start + 3000);
  })();

  it("request_cash_reopen bloqueia a linha do caixa com FOR UPDATE", () => {
    expect(lastRequestFn).toContain("FROM public.daily_cash WHERE id = p_daily_cash_id FOR UPDATE");
    const lockAt = lastRequestFn.indexOf("FOR UPDATE");
    const insertAt = lastRequestFn.indexOf("INSERT INTO public.cash_reopen_requests");
    expect(lockAt).toBeGreaterThan(-1);
    expect(insertAt).toBeGreaterThan(lockAt);
  });

  it("as quatro RPCs públicas têm permissões explícitas", () => {
    for (const sig of [
      "public.request_cash_reopen(uuid, text)",
      "public.approve_cash_reopen_request(uuid, text)",
      "public.reject_cash_reopen_request(uuid, text)",
      "public.admin_reopen_daily_cash(uuid, text)",
    ]) {
      expect(ALL_SQL).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon`);
      expect(ALL_SQL).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO authenticated`);
    }
  });

  it("handleReopenReview não grava auditoria no frontend", () => {
    const src = readFileSync(resolve(SRC_DIR, "components/AdminFullPanel.tsx"), "utf8");
    const start = src.indexOf("async function handleReopenReview");
    const body = src.slice(start, src.indexOf("\n  }", start));
    expect(start).toBeGreaterThan(-1);
    expect(body).not.toContain("requireAudit(");
    expect(body).not.toContain("logAction(");
    expect(body).toContain("loadReopenRequests()");
    // outras funções continuam auditando
    expect(src).toContain("requireAudit(");
  });
});
