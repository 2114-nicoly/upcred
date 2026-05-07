// Edge function: redefine senha de admin ou trabalhador
// Body: { target_kind: 'admin'|'worker', target_id: uuid }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;

function gen(n: number) {
  let s = ""; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10).toString();
  return s;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json(401, { error: "Não autenticado" });

    const userClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: ud, error: ue } = await userClient.auth.getUser();
    if (ue || !ud.user) return json(401, { error: "Sessão inválida" });
    const callerId = ud.user.id;

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", callerId);
    const roleNames = (roles ?? []).map((r: any) => r.role);
    const isSuper = roleNames.includes("super_admin");
    const isAdminRole = roleNames.includes("admin") || isSuper;
    if (!isAdminRole) return json(403, { error: "Sem permissão" });

    const { target_kind, target_id } = await req.json();
    if (!["admin", "worker"].includes(target_kind) || !target_id) {
      return json(400, { error: "Parâmetros inválidos" });
    }

    let authUserId: string | null = null;
    let nome = ""; let loginCodigo = ""; let parentAdminId: string | null = null;

    if (target_kind === "admin") {
      if (!isSuper) return json(403, { error: "Apenas super_admin pode redefinir senhas de admins" });
      const { data: a } = await admin.from("admins").select("auth_user_id, nome, login_codigo, id").eq("id", target_id).maybeSingle();
      if (!a) return json(404, { error: "Admin não encontrado" });
      authUserId = a.auth_user_id;
      nome = a.nome; loginCodigo = a.login_codigo ?? ""; parentAdminId = a.id;
    } else {
      const { data: w } = await admin.from("workers").select("auth_user_id, nome, login_codigo, parent_admin_id").eq("id", target_id).maybeSingle();
      if (!w) return json(404, { error: "Trabalhador não encontrado" });
      // admin comum só pode resetar trabalhador da própria equipe
      if (!isSuper) {
        const { data: myAdmin } = await admin.from("admins").select("id").eq("auth_user_id", callerId).maybeSingle();
        if (!myAdmin || myAdmin.id !== w.parent_admin_id) return json(403, { error: "Trabalhador fora da sua equipe" });
      }
      authUserId = w.auth_user_id;
      nome = w.nome; loginCodigo = w.login_codigo; parentAdminId = w.parent_admin_id;
    }

    if (!authUserId) return json(400, { error: "Usuário sem conta de acesso" });

    const password = gen(8);
    const { error: upErr } = await admin.auth.admin.updateUserById(authUserId, { password });
    if (upErr) return json(400, { error: upErr.message });

    if (target_kind === "admin") {
      await admin.from("admins").update({ temporary_password: true }).eq("id", target_id);
    } else {
      await admin.from("workers").update({ temporary_password: true }).eq("id", target_id);
    }

    await admin.from("worker_credentials_log").insert({
      worker_id: target_kind === "worker" ? target_id : null,
      auth_user_id: authUserId,
      login_codigo: loginCodigo,
      temp_password: password,
      role: target_kind === "admin" ? "admin" : "trabalhador",
      nome,
      admin_id: parentAdminId,
      created_by: callerId,
      reason: "reset",
      status: "pending",
    });

    await admin.rpc("log_audit", {
      p_action: "redefinir_senha", p_entity: target_kind, p_entity_id: target_id,
      p_old: null, p_new: { reset_by: callerId },
      p_obs: "Senha redefinida", p_worker_id: target_kind === "worker" ? target_id : null,
    });

    return json(200, { ok: true, nome, role: target_kind === "admin" ? "admin" : "trabalhador",
      login: loginCodigo, password, created_at: new Date().toISOString() });
  } catch (e: any) {
    return json(500, { error: e?.message || String(e) });
  }
});

function json(status: number, body: any) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
