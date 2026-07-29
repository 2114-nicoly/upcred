// Edge function: aprova uma solicitação de trabalhador (SuperAdministrador),
// cria o usuário/worker/role/credenciais e a primeira licença + período pago.
// Recebe apenas: { request_id, monthly_price, amount_paid, payment_method,
//                  access_start, access_end?, months_granted?, notes? }
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

/** Senha numérica sem viés de módulo. */
function gen(n: number) {
  let s = "";
  for (let i = 0; i < n; i++) {
    let b = 250;
    while (b >= 250) {
      const buf = new Uint8Array(1);
      crypto.getRandomValues(buf);
      b = buf[0];
    }
    s += (b % 10).toString();
  }
  return s;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Soma meses de calendário a uma data local YYYY-MM-DD. */
function addMonths(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const base = new Date(y, m - 1 + months, 1);
  const lastDay = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  const day = Math.min(d, lastDay);
  const mm = String(base.getMonth() + 1).padStart(2, "0");
  return `${base.getFullYear()}-${mm}-${String(day).padStart(2, "0")}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let admin: any = null;
  let requestId: string | null = null;
  let createdUserId: string | null = null;
  let createdWorkerId: string | null = null;
  let createdLicenseId: string | null = null;
  let createdPeriodId: string | null = null;

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json(401, { error: "Não autenticado" });

    const userClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json(401, { error: "Sessão inválida" });
    const callerId = userData.user.id;

    admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", callerId);
    const isSuper = (roles ?? []).some((r: any) => r.role === "super_admin");
    if (!isSuper) return json(403, { error: "Apenas o SuperAdministrador pode aprovar solicitações" });

    // ---------- validação de entrada ----------
    const body = await req.json().catch(() => ({}));
    requestId = typeof body.request_id === "string" ? body.request_id : null;
    if (!requestId) return json(400, { error: "request_id é obrigatório" });

    const monthlyPrice = Number(body.monthly_price ?? 0);
    const amountPaid = Number(body.amount_paid ?? 0);
    const paymentMethod = typeof body.payment_method === "string" ? body.payment_method.trim() || null : null;
    const notes = typeof body.notes === "string" ? body.notes.trim() || null : null;
    const accessStart = typeof body.access_start === "string" ? body.access_start : "";
    const accessEndInput = typeof body.access_end === "string" && body.access_end ? body.access_end : null;
    const monthsGranted = body.months_granted == null ? null : Number(body.months_granted);

    if (!Number.isFinite(monthlyPrice) || monthlyPrice < 0) return json(400, { error: "Valor mensal inválido" });
    if (!Number.isFinite(amountPaid) || amountPaid < 0) return json(400, { error: "Valor pago inválido" });
    if (!DATE_RE.test(accessStart)) return json(400, { error: "Data inicial inválida" });
    if (accessEndInput && !DATE_RE.test(accessEndInput)) return json(400, { error: "Data final inválida" });
    if (!accessEndInput && (!Number.isFinite(monthsGranted as number) || (monthsGranted as number) <= 0)) {
      return json(400, { error: "Quantidade de meses deve ser maior que zero" });
    }
    const accessEnd = accessEndInput ?? addMonths(accessStart, monthsGranted as number);
    if (accessEnd < accessStart) return json(400, { error: "A data final não pode ser anterior à data inicial" });

    // ---------- carregar e travar a solicitação ----------
    const { data: reqRow, error: reqErr } = await admin
      .from("worker_creation_requests").select("*").eq("id", requestId).maybeSingle();
    if (reqErr) return json(400, { error: reqErr.message });
    if (!reqRow) return json(404, { error: "Solicitação não encontrada" });
    if (reqRow.status !== "pending") return json(409, { error: "Esta solicitação já foi respondida ou está em processamento" });

    const { data: locked, error: lockErr } = await admin
      .from("worker_creation_requests")
      .update({ status: "processing" })
      .eq("id", requestId).eq("status", "pending")
      .select("id").maybeSingle();
    if (lockErr) return json(400, { error: lockErr.message });
    if (!locked) return json(409, { error: "Esta solicitação já está sendo processada" });

    const adminId: string = reqRow.admin_id;
    const nome: string = (reqRow.worker_name || "").trim();
    if (!adminId || !nome) throw new Error("Solicitação incompleta (empresa ou nome ausente)");

    // ---------- criação ----------
    const { data: codeData, error: codeErr } = await admin.rpc("generate_worker_login_codigo");
    if (codeErr) throw new Error(codeErr.message);
    const loginCodigo = codeData as string;
    const password = gen(8);
    const syntheticEmail = `w${loginCodigo}@upcred.local`;

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: syntheticEmail,
      password,
      email_confirm: true,
      user_metadata: { display_name: nome },
    });
    if (createErr || !created?.user) throw new Error(createErr?.message || "Falha ao criar usuário");
    createdUserId = created.user.id;

    const { data: workerRow, error: insErr } = await admin.from("workers").insert({
      auth_user_id: createdUserId,
      login_codigo: loginCodigo,
      synthetic_email: syntheticEmail,
      nome,
      notas: reqRow.notes ?? null,
      active: true,
      created_by: callerId,
      parent_admin_id: adminId,
    }).select("id").single();
    if (insErr) throw new Error(insErr.message);
    createdWorkerId = workerRow.id;

    const { error: roleErr } = await admin.from("user_roles")
      .insert({ user_id: createdUserId, role: "trabalhador" });
    if (roleErr) throw new Error(roleErr.message);

    const { error: credErr } = await admin.from("worker_credentials_log").insert({
      worker_id: createdWorkerId,
      auth_user_id: createdUserId,
      login_codigo: loginCodigo,
      temp_password: password,
      role: "trabalhador",
      nome,
      admin_id: adminId,
      created_by: callerId,
      reason: "created",
      status: "pending",
    });
    if (credErr) throw new Error(credErr.message);

    const { data: licenseRow, error: licErr } = await admin.from("worker_access_licenses").insert({
      worker_id: createdWorkerId,
      admin_id: adminId,
      monthly_price: monthlyPrice,
      access_start: accessStart,
      access_end: accessEnd,
      manual_status: "active",
    }).select("id").single();
    if (licErr) throw new Error(licErr.message);
    createdLicenseId = licenseRow.id;

    const { data: periodRow, error: perErr } = await admin.from("worker_access_periods").insert({
      worker_id: createdWorkerId,
      admin_id: adminId,
      period_start: accessStart,
      period_end: accessEnd,
      amount_paid: amountPaid,
      paid_at: new Date().toISOString(),
      months_granted: monthsGranted ?? null,
      payment_method: paymentMethod,
      notes,
      granted_by: callerId,
    }).select("id").single();
    if (perErr) throw new Error(perErr.message);
    createdPeriodId = periodRow.id;

    const { error: finErr } = await admin.from("worker_creation_requests").update({
      status: "approved",
      created_worker_id: createdWorkerId,
      reviewed_by: callerId,
      reviewed_at: new Date().toISOString(),
      rejection_reason: null,
    }).eq("id", requestId).eq("status", "processing");
    if (finErr) throw new Error(finErr.message);

    // ---------- auditoria (nunca a senha) ----------
    const auditPayload = {
      request_id: requestId,
      admin_id: adminId,
      worker_id: createdWorkerId,
      worker_name: nome,
      performed_by: callerId,
      monthly_price: monthlyPrice,
      amount_paid: amountPaid,
      payment_method: paymentMethod,
      access_start: accessStart,
      access_end: accessEnd,
      months_granted: monthsGranted ?? null,
      license_id: createdLicenseId,
      period_id: createdPeriodId,
      timestamp: new Date().toISOString(),
    };
    await admin.rpc("log_audit", {
      p_action: "aprovar_solicitacao_trabalhador", p_entity: "worker", p_entity_id: createdWorkerId,
      p_old: { status: "pending" }, p_new: auditPayload,
      p_obs: "Solicitação aprovada: trabalhador, licença e primeiro período criados",
      p_worker_id: createdWorkerId,
    }).catch(() => {});

    return json(200, {
      ok: true,
      nome,
      role: "trabalhador",
      login: loginCodigo,
      login_codigo: loginCodigo,
      password,
      worker_id: createdWorkerId,
      access_start: accessStart,
      access_end: accessEnd,
      created_at: new Date().toISOString(),
    });
  } catch (e: any) {
    // ---------- rollback ----------
    if (admin) {
      if (createdPeriodId) await admin.from("worker_access_periods").delete().eq("id", createdPeriodId).then(() => {}, () => {});
      if (createdLicenseId) await admin.from("worker_access_licenses").delete().eq("id", createdLicenseId).then(() => {}, () => {});
      if (createdWorkerId) {
        await admin.from("worker_credentials_log").delete().eq("worker_id", createdWorkerId).then(() => {}, () => {});
        await admin.from("workers").delete().eq("id", createdWorkerId).then(() => {}, () => {});
      }
      if (createdUserId) {
        await admin.from("user_roles").delete().eq("user_id", createdUserId).then(() => {}, () => {});
        await admin.auth.admin.deleteUser(createdUserId).catch(() => {});
      }
      if (requestId) {
        await admin.from("worker_creation_requests")
          .update({ status: "pending", created_worker_id: null })
          .eq("id", requestId).eq("status", "processing").then(() => {}, () => {});
      }
    }
    return json(500, { error: e?.message || String(e) });
  }
});
