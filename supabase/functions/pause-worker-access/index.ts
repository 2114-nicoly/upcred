// Edge function: pausa manual da licença individual de um trabalhador.
// Somente SuperAdministrador. NÃO bloqueia login, não altera datas, preço,
// histórico de pagamentos, workers.active, usuário do Auth ou dados operacionais.
// Body: { worker_id, reason }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;

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
    if (!isSuper) return json(403, { error: "Apenas o SuperAdministrador pode pausar acessos" });

    const body = await req.json().catch(() => ({}));
    const workerId = typeof body.worker_id === "string" ? body.worker_id.trim() : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!workerId) return json(400, { error: "worker_id é obrigatório" });
    if (reason.length < 3) return json(400, { error: "Informe o motivo da pausa" });
    if (reason.length > 500) return json(400, { error: "Motivo muito longo" });

    // Vínculos carregados no servidor — nada vindo do frontend é confiável.
    const { data: worker } = await admin
      .from("workers").select("id, nome, parent_admin_id").eq("id", workerId).maybeSingle();
    if (!worker) return json(404, { error: "Trabalhador não encontrado" });
    const adminId: string | null = worker.parent_admin_id ?? null;

    const { data: license } = await admin
      .from("worker_access_licenses")
      .select("id, manual_status, access_start, access_end, monthly_price, pause_reason, paused_at, paused_by")
      .eq("worker_id", workerId).maybeSingle();
    if (!license) return json(400, { error: "Trabalhador sem licença configurada" });
    if (license.manual_status === "paused") return json(409, { error: "Esta licença já está pausada" });

    const nowIso = new Date().toISOString();
    const { error: upErr } = await admin.from("worker_access_licenses").update({
      manual_status: "paused",
      pause_reason: reason,
      paused_at: nowIso,
      paused_by: callerId,
      admin_id: adminId,
    }).eq("id", license.id);
    if (upErr) return json(500, { error: upErr.message });

    let companyName: string | null = null;
    if (adminId) {
      const { data: comp } = await admin.from("admins").select("nome").eq("id", adminId).maybeSingle();
      companyName = comp?.nome ?? null;
    }

    try {
      await admin.rpc("log_audit", {
        p_action: "pausar_licenca_trabalhador",
        p_entity: "worker",
        p_entity_id: workerId,
        p_old: { manual_status: license.manual_status, pause_reason: license.pause_reason, paused_at: license.paused_at, paused_by: license.paused_by },
        p_new: {
          worker_id: workerId,
          worker_name: worker.nome,
          admin_id: adminId,
          company_name: companyName,
          license_id: license.id,
          manual_status: "paused",
          pause_reason: reason,
          paused_at: nowIso,
          performed_by: callerId,
          access_end: license.access_end,
          monthly_price: license.monthly_price,
        },
        p_obs: `Licença pausada: ${reason}`,
        p_worker_id: workerId,
      });
    } catch { /* auditoria não bloqueia a operação */ }

    return json(200, { ok: true, worker_id: workerId, license_id: license.id, manual_status: "paused", paused_at: nowIso });
  } catch (e: any) {
    return json(500, { error: e?.message ?? "Erro inesperado" });
  }
});
