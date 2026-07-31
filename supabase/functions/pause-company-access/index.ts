// Edge function: pausa manual do acesso de uma EMPRESA (administrador + trabalhadores).
// Somente SuperAdministrador. Altera exclusivamente company_access_controls.
// NÃO altera admins.active, workers.active, usuários do Auth, senhas, licenças,
// períodos, clientes, empréstimos, parcelas, caixa, relatórios ou históricos.
// Body: { admin_id, reason }
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
    if (!isSuper) return json(403, { error: "Apenas o SuperAdministrador pode pausar empresas" });

    const body = await req.json().catch(() => ({}));
    const adminId = typeof body.admin_id === "string" ? body.admin_id.trim() : "";
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!adminId) return json(400, { error: "admin_id é obrigatório" });
    if (reason.length < 3) return json(400, { error: "Informe o motivo da pausa" });
    if (reason.length > 500) return json(400, { error: "Motivo muito longo" });

    const { data: company } = await admin
      .from("admins").select("id, nome").eq("id", adminId).maybeSingle();
    if (!company) return json(404, { error: "Empresa não encontrada" });

    const { data: control } = await admin
      .from("company_access_controls")
      .select("id, manual_status, pause_reason, paused_at, paused_by")
      .eq("admin_id", adminId).maybeSingle();
    if (control?.manual_status === "paused") return json(409, { error: "Esta empresa já está pausada" });

    const nowIso = new Date().toISOString();
    const patch = {
      manual_status: "paused",
      pause_reason: reason,
      paused_at: nowIso,
      paused_by: callerId,
      updated_at: nowIso,
    };

    if (control?.id) {
      const { error } = await admin.from("company_access_controls").update(patch).eq("id", control.id);
      if (error) return json(500, { error: error.message });
    } else {
      const { error } = await admin.from("company_access_controls").insert({ admin_id: adminId, ...patch });
      if (error) return json(500, { error: error.message });
    }

    const { count: workersCount } = await admin
      .from("workers").select("id", { count: "exact", head: true }).eq("parent_admin_id", adminId);

    try {
      await admin.rpc("log_audit", {
        p_action: "pausar_empresa",
        p_entity: "company",
        p_entity_id: adminId,
        p_old: {
          manual_status: control?.manual_status ?? "active",
          pause_reason: control?.pause_reason ?? null,
          paused_at: control?.paused_at ?? null,
          paused_by: control?.paused_by ?? null,
        },
        p_new: {
          admin_id: adminId,
          company_name: company.nome,
          manual_status: "paused",
          pause_reason: reason,
          paused_at: nowIso,
          performed_by: callerId,
          workers_count: workersCount ?? 0,
        },
        p_obs: `Empresa pausada: ${reason}`,
        p_worker_id: null,
      });
    } catch { /* auditoria não bloqueia a operação */ }

    return json(200, { ok: true, admin_id: adminId, manual_status: "paused", paused_at: nowIso });
  } catch (e: any) {
    return json(500, { error: e?.message ?? "Erro inesperado" });
  }
});
