// Edge function: reativação manual do acesso de uma EMPRESA.
// Somente SuperAdministrador. Limpa apenas a pausa atual em company_access_controls.
// NÃO renova licenças, não altera vencimentos, não reativa licença individual pausada,
// não cria pagamentos e não modifica trabalhadores ou dados operacionais.
// Body: { admin_id }
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
    if (!isSuper) return json(403, { error: "Apenas o SuperAdministrador pode reativar empresas" });

    const body = await req.json().catch(() => ({}));
    const adminId = typeof body.admin_id === "string" ? body.admin_id.trim() : "";
    if (!adminId) return json(400, { error: "admin_id é obrigatório" });

    const { data: company } = await admin
      .from("admins").select("id, nome").eq("id", adminId).maybeSingle();
    if (!company) return json(404, { error: "Empresa não encontrada" });

    const { data: control } = await admin
      .from("company_access_controls")
      .select("id, manual_status, pause_reason, paused_at, paused_by")
      .eq("admin_id", adminId).maybeSingle();
    if (!control || control.manual_status !== "paused") {
      return json(409, { error: "Esta empresa não está pausada" });
    }

    const nowIso = new Date().toISOString();
    const { error: upErr } = await admin.from("company_access_controls").update({
      manual_status: "active",
      pause_reason: null,
      paused_at: null,
      paused_by: null,
      updated_at: nowIso,
    }).eq("id", control.id);
    if (upErr) return json(500, { error: upErr.message });

    try {
      await admin.rpc("log_audit", {
        p_action: "reativar_empresa",
        p_entity: "company",
        p_entity_id: adminId,
        p_old: {
          manual_status: "paused",
          pause_reason: control.pause_reason,
          paused_at: control.paused_at,
          paused_by: control.paused_by,
        },
        p_new: {
          admin_id: adminId,
          company_name: company.nome,
          manual_status: "active",
          reactivated_at: nowIso,
          performed_by: callerId,
        },
        p_obs: `Empresa reativada (pausa anterior: ${control.pause_reason ?? "—"})`,
        p_worker_id: null,
      });
    } catch { /* auditoria não bloqueia a operação */ }

    return json(200, { ok: true, admin_id: adminId, manual_status: "active" });
  } catch (e: any) {
    return json(500, { error: e?.message ?? "Erro inesperado" });
  }
});
