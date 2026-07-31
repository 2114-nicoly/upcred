// Edge function: correção manual das datas do período atual de acesso.
// Somente SuperAdministrador. Não registra renovação, nem pagamento, nem
// altera valores, pausas, empresa, usuário ou credenciais.
// Body: { worker_id, access_start, access_end }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function json(status: number, body: any) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json(401, { error: "Não autenticado" });

    const userClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json(401, { error: "Sessão inválida" });
    const callerId = userData.user.id;

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", callerId);
    const isSuper = (roles ?? []).some((r: any) => r.role === "super_admin");
    if (!isSuper) return json(403, { error: "Apenas o SuperAdministrador pode editar o período" });

    const body = await req.json().catch(() => ({}));
    const workerId = typeof body.worker_id === "string" ? body.worker_id : null;
    const accessStart = typeof body.access_start === "string" ? body.access_start : "";
    const accessEnd = typeof body.access_end === "string" ? body.access_end : "";

    if (!workerId) return json(400, { error: "worker_id é obrigatório" });
    if (!DATE_RE.test(accessStart)) return json(400, { error: "Data inicial inválida" });
    if (!DATE_RE.test(accessEnd)) return json(400, { error: "Data final inválida" });
    if (accessEnd < accessStart) return json(400, { error: "A data final não pode ser anterior à data inicial" });

    const { data: worker, error: wErr } = await admin
      .from("workers").select("id, nome, parent_admin_id").eq("id", workerId).maybeSingle();
    if (wErr) return json(400, { error: wErr.message });
    if (!worker) return json(404, { error: "Trabalhador não encontrado" });

    const { data: license } = await admin
      .from("worker_access_licenses")
      .select("id, access_start, access_end, manual_status, monthly_price, admin_id")
      .eq("worker_id", workerId).maybeSingle();
    if (!license) return json(404, { error: "Trabalhador sem licença configurada" });

    const oldStart = license.access_start ? String(license.access_start).slice(0, 10) : null;
    const oldEnd = license.access_end ? String(license.access_end).slice(0, 10) : null;

    // Atualiza exatamente as datas da licença.
    const { error: upErr } = await admin
      .from("worker_access_licenses")
      .update({ access_start: accessStart, access_end: accessEnd })
      .eq("id", license.id);
    if (upErr) return json(500, { error: upErr.message });

    // Histórico: ajusta apenas o período correspondente ao acesso atual.
    let updatedPeriodId: string | null = null;
    const { data: lastPeriod } = await admin
      .from("worker_access_periods")
      .select("id, period_start, period_end")
      .eq("worker_id", workerId)
      .order("created_at", { ascending: false })
      .limit(1).maybeSingle();

    if (lastPeriod && oldEnd && String(lastPeriod.period_end ?? "").slice(0, 10) === oldEnd) {
      const { error: perErr } = await admin
        .from("worker_access_periods")
        .update({ period_start: accessStart, period_end: accessEnd })
        .eq("id", lastPeriod.id);
      if (!perErr) updatedPeriodId = lastPeriod.id;
    }

    try {
      await admin.rpc("log_audit", {
        p_action: "editar_periodo_acesso_trabalhador",
        p_entity: "worker",
        p_entity_id: workerId,
        p_old: {
          license_id: license.id,
          access_start: oldStart,
          access_end: oldEnd,
          period_id: lastPeriod?.id ?? null,
          period_start: lastPeriod?.period_start ?? null,
          period_end: lastPeriod?.period_end ?? null,
        },
        p_new: {
          worker_id: workerId,
          worker_name: worker.nome,
          admin_id: worker.parent_admin_id ?? license.admin_id ?? null,
          license_id: license.id,
          access_start: accessStart,
          access_end: accessEnd,
          period_id: updatedPeriodId,
          performed_by: callerId,
          timestamp: new Date().toISOString(),
        },
        p_obs: "Correção manual do período de acesso",
        p_worker_id: workerId,
      });
    } catch (e) {
      console.error("Falha ao registrar auditoria:", e);
    }

    return json(200, {
      ok: true,
      access_start: accessStart,
      access_end: accessEnd,
      period_updated: updatedPeriodId,
    });
  } catch (e: any) {
    console.error(e);
    return json(500, { error: e?.message ?? "Erro inesperado" });
  }
});
