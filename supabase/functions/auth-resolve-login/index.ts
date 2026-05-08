// Edge function pública: dado um login (4, 5 dígitos ou email), retorna o email para signInWithPassword
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function confirmManagedUser(admin: any, authUserId: string | null) {
  if (!authUserId) return;
  await admin.auth.admin.updateUserById(authUserId, { email_confirm: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { login } = await req.json();
    const rawValue = String(login || "").trim().toLowerCase();
    const value = rawValue.includes("@") ? rawValue : rawValue.replace(/\D/g, "");
    if (!value) return json(400, { error: "Login obrigatório" });

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // Email real continua funcionando para super_admin/admin, mas também repara confirmação pendente.
    if (value.includes("@")) {
      const { data: adminByEmail } = await admin.from("admins")
        .select("email_real, active, auth_user_id")
        .eq("email_real", value).maybeSingle();
      if (adminByEmail) {
        if (!adminByEmail.active) return json(403, { error: "Usuário inativo" });
        await confirmManagedUser(admin, adminByEmail.auth_user_id);
        return json(200, { email: adminByEmail.email_real });
      }
      return json(200, { email: value });
    }

    if (/^\d{4}$/.test(value)) {
      const { data } = await admin.from("workers")
        .select("synthetic_email, active, auth_user_id, archived_at")
        .eq("login_codigo", value).maybeSingle();
      if (!data) return json(404, { error: "Login não encontrado" });
      if (data.archived_at) return json(403, { error: "Usuário arquivado" });
      if (!data.active) return json(403, { error: "Usuário inativo" });
      await confirmManagedUser(admin, data.auth_user_id);
      return json(200, { email: data.synthetic_email });
    }
    if (/^\d{5}$/.test(value)) {
      const { data } = await admin.from("admins")
        .select("email_real, active, auth_user_id")
        .eq("login_codigo", value).maybeSingle();
      if (!data) return json(404, { error: "Login não encontrado" });
      if (!data.active) return json(403, { error: "Usuário inativo" });
      await confirmManagedUser(admin, data.auth_user_id);
      return json(200, { email: data.email_real });
    }
    return json(400, { error: "Formato de login inválido" });
  } catch (e: any) {
    return json(500, { error: e?.message || String(e) });
  }
});

function json(status: number, body: any) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
