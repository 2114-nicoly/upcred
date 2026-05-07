// Edge function pública: dado um login (4, 5 dígitos ou email), retorna o email para signInWithPassword
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { login } = await req.json();
    const value = String(login || "").trim();
    if (!value) return json(400, { error: "Login obrigatório" });

    // se for email, devolve direto
    if (value.includes("@")) return json(200, { email: value });

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    if (/^\d{4}$/.test(value)) {
      const { data } = await admin.from("workers")
        .select("synthetic_email, active")
        .eq("login_codigo", value).maybeSingle();
      if (!data) return json(404, { error: "Login não encontrado" });
      if (!data.active) return json(403, { error: "Usuário inativo" });
      return json(200, { email: data.synthetic_email });
    }
    if (/^\d{5}$/.test(value)) {
      const { data } = await admin.from("admins")
        .select("email_real, active")
        .eq("login_codigo", value).maybeSingle();
      if (!data) return json(404, { error: "Login não encontrado" });
      if (!data.active) return json(403, { error: "Usuário inativo" });
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
