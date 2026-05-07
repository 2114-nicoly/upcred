// Edge function: cria admin ou trabalhador no Supabase Auth e registra no banco
// Recebe: { kind: 'admin'|'worker', nome, email_real?, notas?, parent_admin_id? }
// Retorna credenciais geradas (login_codigo + senha temporária)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;

function gen(n: number) {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10).toString();
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
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json(401, { error: "Sessão inválida" });
    const callerId = userData.user.id;

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // verifica role do chamador
    const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", callerId);
    const roleNames = (roles ?? []).map((r: any) => r.role);
    const isSuper = roleNames.includes("super_admin");
    const isAdmin = roleNames.includes("admin") || isSuper;

    const body = await req.json();
    const kind = body.kind as "admin" | "worker";
    const nome = (body.nome || "").trim();
    const notas = body.notas ?? null;
    if (!nome) return json(400, { error: "Nome é obrigatório" });

    if (kind === "admin") {
      if (!isSuper) return json(403, { error: "Apenas super_admin pode criar administradores" });
      const emailReal = (body.email_real || "").trim().toLowerCase();
      if (!emailReal) return json(400, { error: "Email é obrigatório" });

      const { data: codeData } = await admin.rpc("generate_admin_login_codigo");
      const loginCodigo = codeData as string;
      const password = gen(8);

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email: emailReal,
        password,
        email_confirm: true,
        user_metadata: { display_name: nome },
      });
      if (createErr || !created.user) return json(400, { error: createErr?.message || "Falha ao criar usuário" });
      const newUserId = created.user.id;

      const { data: adminRow, error: regErr } = await admin.from("admins").insert({
        auth_user_id: newUserId,
        nome,
        email_real: emailReal,
        login_codigo: loginCodigo,
        active: true,
        created_by: callerId,
        notas,
      } as any).select("id").single();
      if (regErr) {
        await admin.auth.admin.deleteUser(newUserId).catch(() => {});
        return json(400, { error: regErr.message });
      }
      const adminId = adminRow.id;
      await admin.from("user_roles").insert({ user_id: newUserId, role: "admin" }).select();

      await admin.from("worker_credentials_log").insert({
        worker_id: null,
        auth_user_id: newUserId,
        login_codigo: loginCodigo,
        temp_password: password,
        role: "admin",
        nome,
        admin_id: adminId,
        created_by: callerId,
        reason: "created",
        status: "pending",
      });

      await admin.rpc("log_audit", {
        p_action: "criar_admin", p_entity: "admin", p_entity_id: adminId,
        p_old: null, p_new: { nome, email: emailReal, login_codigo: loginCodigo },
        p_obs: "Admin criado", p_worker_id: null,
      });

      return json(200, {
        ok: true, kind: "admin", nome, role: "admin",
        login: emailReal, login_codigo: loginCodigo, password,
        created_at: new Date().toISOString(),
      });
    }

    if (kind === "worker") {
      if (!isAdmin) return json(403, { error: "Apenas admin pode criar trabalhadores" });

      // determina parent_admin_id
      let parentAdminId: string | null = body.parent_admin_id ?? null;
      if (!isSuper) {
        const { data: myAdmin } = await admin.from("admins").select("id").eq("auth_user_id", callerId).maybeSingle();
        if (myAdmin?.id) parentAdminId = myAdmin.id;
      }
      if (!parentAdminId) return json(400, { error: "Equipe (admin) não definida" });

      const { data: codeData } = await admin.rpc("generate_worker_login_codigo");
      const loginCodigo = codeData as string;
      const password = gen(8);
      const syntheticEmail = `w${loginCodigo}@upcred.local`;

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email: syntheticEmail,
        password,
        email_confirm: true,
        user_metadata: { display_name: nome },
      });
      if (createErr || !created.user) return json(400, { error: createErr?.message || "Falha ao criar usuário" });
      const newUserId = created.user.id;

      // insere worker manualmente para ter controle do parent_admin_id
      const { data: workerRow, error: insErr } = await admin.from("workers").insert({
        auth_user_id: newUserId,
        login_codigo: loginCodigo,
        synthetic_email: syntheticEmail,
        nome,
        notas,
        active: true,
        created_by: callerId,
        parent_admin_id: parentAdminId,
      } as any).select("id").single();
      if (insErr) {
        await admin.auth.admin.deleteUser(newUserId).catch(() => {});
        return json(400, { error: insErr.message });
      }

      await admin.from("user_roles").insert({ user_id: newUserId, role: "trabalhador" }).select();

      await admin.from("worker_credentials_log").insert({
        worker_id: workerRow.id,
        auth_user_id: newUserId,
        login_codigo: loginCodigo,
        temp_password: password,
        role: "trabalhador",
        nome,
        admin_id: parentAdminId,
        created_by: callerId,
        reason: "created",
        status: "pending",
      });

      await admin.rpc("log_audit", {
        p_action: "criar_trabalhador", p_entity: "worker", p_entity_id: workerRow.id,
        p_old: null, p_new: { nome, login_codigo: loginCodigo },
        p_obs: "Trabalhador criado", p_worker_id: workerRow.id,
      });

      return json(200, {
        ok: true, kind: "worker", nome, role: "trabalhador",
        login: loginCodigo, login_codigo: loginCodigo, password,
        created_at: new Date().toISOString(),
      });
    }

    return json(400, { error: "kind inválido" });
  } catch (e: any) {
    return json(500, { error: e?.message || String(e) });
  }
});

function json(status: number, body: any) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
