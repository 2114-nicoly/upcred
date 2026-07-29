// Edge function: reativação manual da licença individual de um trabalhador.
// Somente SuperAdministrador. Não cria período, não registra pagamento,
// não renova e não altera access_end — apenas limpa a situação de pausa.
// Body: { worker_id }
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
    if (!isSuper) return json(403, { error: "Apenas o SuperAdministrador pode reativar acessos" });

    const body = await req.json().catch(() => ({}));
    const workerId = typeof body.worker_id === "string" ? body.worker_id.trim() : "";
    if (!workerId) return json(400, { error: "worker_id é obrigatório" });

    const { data: worker } = await admin
      .from("workers").select("id, nome, parent_admin_id").eq("id", workerId).maybeSingle();
    if (!worker) return json(404, { error: "Trabalhador não encontrado" });
    const adminId: string | null = worker.parent_admin_id ?? null;

    const { data: license } = await admin
      .from("worker_access_licenses")
      .select("id, manual_status, access_start, access_end, monthly_price, pause_reason, paused_at, paused_by")
      .eq("worker_id", workerId).maybeSingle();
    if (!license) return json(400, { error: "Trabalhador sem licença configurada" });
    if (license.manual_status !== "paused") return json(409, { error: "Esta licença não está pausada" });

    const { error: upErr } = await admin.from("worker_access_licenses").update({
      manual_status: "active",
      pause_reason: null,
      paused_at: null,
      paused_by: null,
      admin_id: adminId,
      // datas e preço preservados propositalmente
    }).eq("id", license.id);
    if (upErr) return json(500, { error: upErr.message });

    let companyName: string | null = null;
    if (adminId) {
      const { data: comp } = await admin.from("admins").select("nome").eq("id", adminId).maybeSingle();
      companyName = comp?.nome ?? null;
    }

    await admin.rpc("log_audit", {
      p_action: "reativar_licenca_trabalhador",
      p_entity: "worker",
      p_entity_id: workerId,
      p_old: {
        manual_status: "paused",
        pause_reason: license.pause_reason,
        paused_at: license.paused_at,
        paused_by: license.paused_by,
      },
      p_new: {
        worker_id: workerId,
        worker_name: worker.nome,
        admin_id: adminId,
        company_name: companyName,
        license_id: license.id,
        manual_status: "active",
        access_start: license.access_start,
        access_end: license.access_end,
        monthly_price: license.monthly_price,
        performed_by: callerId,
        timestamp: new Date().toISOString(),
      },
      p_obs: "Licença reativada manualmente",
      p_worker_id: workerId,
    }).catch(() => {});

    return json(200, { ok: true, worker_id: workerId, license_id: license.id, manual_status: "active", access_end: license.access_end });
  } catch (e: any) {
    return json(500, { error: e?.message ?? "Erro inesperado" });
  }
});
