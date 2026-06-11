// Edge function: edita dados de um trabalhador (nome, login_codigo, notas, active).
// Mantém o mesmo id e preserva todos os relacionamentos.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!;

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
    const roleNames = (roles ?? []).map((r: any) => r.role);
    const isSuper = roleNames.includes("super_admin");
    const isAdmin = roleNames.includes("admin") || isSuper;
    if (!isAdmin) return json(403, { error: "Apenas admin pode editar trabalhadores" });

    const body = await req.json();
    const workerId = String(body.worker_id || "").trim();
    if (!workerId) return json(400, { error: "worker_id é obrigatório" });

    const nome = typeof body.nome === "string" ? body.nome.trim() : null;
    const loginCodigo = typeof body.login_codigo === "string" ? body.login_codigo.trim() : null;
    const notas = body.notas === undefined ? undefined : (body.notas ?? null);
    const active = typeof body.active === "boolean" ? body.active : undefined;

    if (nome !== null && nome.length === 0) return json(400, { error: "Nome não pode ficar vazio" });
    if (loginCodigo !== null) {
      if (!/^\d{4}$/.test(loginCodigo)) return json(400, { error: "Login deve ter 4 dígitos numéricos" });
    }

    // Carrega trabalhador
    const { data: worker, error: wErr } = await admin
      .from("workers")
      .select("id, nome, login_codigo, synthetic_email, auth_user_id, parent_admin_id, active, notas")
      .eq("id", workerId)
      .maybeSingle();
    if (wErr || !worker) return json(404, { error: "Trabalhador não encontrado" });

    // Verifica escopo do admin (não super) — só pode editar seus próprios trabalhadores
    if (!isSuper) {
      const { data: myAdmin } = await admin.from("admins").select("id").eq("auth_user_id", callerId).maybeSingle();
      if (!myAdmin?.id || worker.parent_admin_id !== myAdmin.id) {
        return json(403, { error: "Você não pode editar este trabalhador" });
      }
    }

    const updates: Record<string, any> = {};
    const changed: Record<string, { old: any; new: any }> = {};

    if (nome !== null && nome !== worker.nome) {
      updates.nome = nome;
      changed.nome = { old: worker.nome, new: nome };
    }
    if (notas !== undefined && notas !== worker.notas) {
      updates.notas = notas;
      changed.notas = { old: worker.notas, new: notas };
    }
    if (active !== undefined && active !== worker.active) {
      updates.active = active;
      changed.active = { old: worker.active, new: active };
    }

    let newSyntheticEmail: string | null = null;
    if (loginCodigo !== null && loginCodigo !== worker.login_codigo) {
      // checa duplicidade
      const [{ data: dupW }, { data: dupA }] = await Promise.all([
        admin.from("workers").select("id").eq("login_codigo", loginCodigo).neq("id", workerId).maybeSingle(),
        admin.from("admins").select("id").eq("login_codigo", loginCodigo).maybeSingle(),
      ]);
      if (dupW || dupA) return json(409, { error: "Este login já está em uso" });
      newSyntheticEmail = `w${loginCodigo}@upcred.local`;
      updates.login_codigo = loginCodigo;
      updates.synthetic_email = newSyntheticEmail;
      changed.login_codigo = { old: worker.login_codigo, new: loginCodigo };
    }

    if (Object.keys(updates).length === 0) {
      return json(200, { ok: true, unchanged: true });
    }

    // Atualiza auth.users email se login mudou
    if (newSyntheticEmail && worker.auth_user_id) {
      const { error: authErr } = await admin.auth.admin.updateUserById(worker.auth_user_id, {
        email: newSyntheticEmail,
        email_confirm: true,
        ...(updates.nome ? { user_metadata: { display_name: updates.nome } } : {}),
      });
      if (authErr) return json(400, { error: `Falha ao atualizar credencial: ${authErr.message}` });
    } else if (updates.nome && worker.auth_user_id) {
      await admin.auth.admin.updateUserById(worker.auth_user_id, {
        user_metadata: { display_name: updates.nome },
      }).catch(() => {});
    }

    const { error: updErr } = await admin.from("workers").update(updates).eq("id", workerId);
    if (updErr) return json(400, { error: updErr.message });

    await admin.rpc("log_audit", {
      p_action: "editar_trabalhador",
      p_entity: "worker",
      p_entity_id: workerId,
      p_old: null,
      p_new: changed,
      p_obs: "Trabalhador editado",
      p_worker_id: workerId,
    }).catch(() => {});

    return json(200, { ok: true, changed });
  } catch (e: any) {
    return json(500, { error: e?.message || String(e) });
  }
});

function json(status: number, body: any) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
