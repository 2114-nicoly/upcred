// Edge function: renovação segura da licença/mensalidade de um trabalhador.
// Somente SuperAdministrador. Nunca cria usuário, trabalhador ou credenciais,
// nunca movimenta o caixa operacional e nunca bloqueia acesso.
// Body: { worker_id, monthly_price, amount_paid, payment_method, months_granted,
//         custom_start_date?, custom_end_date?, notes? }
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Data local de hoje em YYYY-MM-DD (fuso do servidor tratado como local). */
function todayLocal(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Soma meses de calendário a uma data local YYYY-MM-DD. */
function addMonths(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const base = new Date(y, m - 1 + months, 1);
  const lastDay = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  const mm = String(base.getMonth() + 1).padStart(2, "0");
  const dd = String(Math.min(d, lastDay)).padStart(2, "0");
  return `${base.getFullYear()}-${mm}-${dd}`;
}

/** Dia anterior a uma data local YYYY-MM-DD. */
function prevDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const n = new Date(y, m - 1, d - 1);
  const mm = String(n.getMonth() + 1).padStart(2, "0");
  const dd = String(n.getDate()).padStart(2, "0");
  return `${n.getFullYear()}-${mm}-${dd}`;
}

/** Fim do período: início + N meses − 1 dia (mesma regra do frontend). */
function addMonthsEnd(startStr: string, months: number): string {
  return prevDay(addMonths(startStr, months));
}


Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let admin: any = null;
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
    if (!isSuper) return json(403, { error: "Apenas o SuperAdministrador pode renovar licenças" });

    // ---------- entrada ----------
    const body = await req.json().catch(() => ({}));
    const workerId = typeof body.worker_id === "string" ? body.worker_id : null;
    if (!workerId) return json(400, { error: "worker_id é obrigatório" });

    const monthlyPrice = Number(body.monthly_price ?? 0);
    const amountPaid = Number(body.amount_paid ?? 0);
    const paymentMethod = typeof body.payment_method === "string" ? body.payment_method.trim() || null : null;
    const notes = typeof body.notes === "string" ? body.notes.trim() || null : null;
    const monthsGranted = Number(body.months_granted ?? 0);
    const customStart = typeof body.custom_start_date === "string" && body.custom_start_date ? body.custom_start_date : null;
    const customEnd = typeof body.custom_end_date === "string" && body.custom_end_date ? body.custom_end_date : null;

    if (!Number.isFinite(monthlyPrice) || monthlyPrice < 0) return json(400, { error: "Valor mensal inválido" });
    if (!Number.isFinite(amountPaid) || amountPaid < 0) return json(400, { error: "Valor pago inválido" });
    if (!customEnd && (!Number.isFinite(monthsGranted) || monthsGranted <= 0)) {
      return json(400, { error: "Quantidade de meses deve ser maior que zero" });
    }
    if (customStart && !DATE_RE.test(customStart)) return json(400, { error: "Data inicial inválida" });
    if (customEnd && !DATE_RE.test(customEnd)) return json(400, { error: "Data final inválida" });

    // ---------- dados carregados no servidor (nunca vindos do frontend) ----------
    const { data: worker, error: wErr } = await admin
      .from("workers").select("id, nome, parent_admin_id").eq("id", workerId).maybeSingle();
    if (wErr) return json(400, { error: wErr.message });
    if (!worker) return json(404, { error: "Trabalhador não encontrado" });
    const adminId: string | null = worker.parent_admin_id ?? null;
    if (!adminId) return json(400, { error: "Trabalhador sem empresa responsável" });

    const { data: license } = await admin
      .from("worker_access_licenses")
      .select("id, worker_id, admin_id, monthly_price, access_start, access_end, manual_status")
      .eq("worker_id", workerId).maybeSingle();

    const { data: lastPeriod } = await admin
      .from("worker_access_periods")
      .select("id, period_start, period_end, amount_paid, created_at")
      .eq("worker_id", workerId)
      .order("created_at", { ascending: false })
      .limit(1).maybeSingle();

    const today = todayLocal();
    const currentEnd: string | null = license?.access_end ? String(license.access_end).slice(0, 10) : null;
    const stillValid = !!currentEnd && currentEnd >= today;

    // ---------- início do novo período ----------
    let periodStart: string;
    if (stillValid) {
      // Renovação antecipada: continua no dia seguinte ao fim atual (não perde dias pagos).
      periodStart = nextDay(currentEnd!);
    } else {
      periodStart = customStart ?? today;
    }

    const periodEnd = customEnd ?? addMonths(periodStart, monthsGranted);
    if (periodEnd < periodStart) return json(400, { error: "A data final não pode ser anterior à data inicial" });

    // ---------- proteção contra duplicidade ----------
    if (lastPeriod
      && String(lastPeriod.period_start ?? "").slice(0, 10) === periodStart
      && String(lastPeriod.period_end ?? "").slice(0, 10) === periodEnd
      && Number(lastPeriod.amount_paid ?? 0) === amountPaid) {
      const ageMs = Date.now() - new Date(lastPeriod.created_at).getTime();
      if (ageMs < 5 * 60 * 1000) {
        return json(409, { error: "Esta renovação já foi registrada há instantes. Atualize a tela antes de tentar novamente." });
      }
    }

    // ---------- histórico primeiro (obrigatório) ----------
    const nowIso = new Date().toISOString();
    const { data: periodRow, error: perErr } = await admin.from("worker_access_periods").insert({
      worker_id: workerId,
      admin_id: adminId,
      period_start: periodStart,
      period_end: periodEnd,
      amount_paid: amountPaid,
      paid_at: nowIso,
      months_granted: customEnd ? (Number.isFinite(monthsGranted) && monthsGranted > 0 ? monthsGranted : null) : monthsGranted,
      payment_method: paymentMethod,
      notes,
      granted_by: callerId,
    }).select("id").single();
    if (perErr || !periodRow) {
      return json(500, { error: `Falha ao registrar o histórico da renovação: ${perErr?.message ?? "erro desconhecido"}` });
    }
    createdPeriodId = periodRow.id;

    // ---------- licença ----------
    let licenseId: string;
    if (license) {
      const { error: upErr } = await admin.from("worker_access_licenses").update({
        admin_id: adminId,
        monthly_price: monthlyPrice,
        // access_start só é definido quando ainda não existe; manual_status preservado.
        access_start: license.access_start ?? periodStart,
        access_end: periodEnd,
      }).eq("id", license.id);
      if (upErr) throw new Error(upErr.message);
      licenseId = license.id;
    } else {
      const { data: newLic, error: insErr } = await admin.from("worker_access_licenses").insert({
        worker_id: workerId,
        admin_id: adminId,
        monthly_price: monthlyPrice,
        access_start: periodStart,
        access_end: periodEnd,
        manual_status: "active",
      }).select("id").single();
      if (insErr || !newLic) throw new Error(insErr?.message || "Falha ao criar a licença");
      licenseId = newLic.id;
    }

    // ---------- auditoria (nunca senha/credenciais) ----------
    try {
      await admin.rpc("log_audit", {
      p_action: "renovar_licenca_trabalhador",
      p_entity: "worker",
      p_entity_id: workerId,
      p_old: {
        license_id: license?.id ?? null,
        access_start: license?.access_start ?? null,
        access_end: currentEnd,
        monthly_price: license?.monthly_price ?? null,
        manual_status: license?.manual_status ?? null,
      },
      p_new: {
        worker_id: workerId,
        worker_name: worker.nome,
        admin_id: adminId,
        license_id: licenseId,
        period_id: createdPeriodId,
        period_start: periodStart,
        period_end: periodEnd,
        months_granted: monthsGranted || null,
        monthly_price: monthlyPrice,
        amount_paid: amountPaid,
        payment_method: paymentMethod,
        notes,
        early_renewal: stillValid,
        performed_by: callerId,
        timestamp: nowIso,
      },
      p_obs: notes ?? (stillValid ? "Renovação antecipada de licença" : "Renovação de licença"),
      p_worker_id: workerId,
      });
    } catch { /* auditoria não bloqueia a renovação */ }

    return json(200, {
      ok: true,
      worker_id: workerId,
      license_id: licenseId,
      period_id: createdPeriodId,
      period_start: periodStart,
      period_end: periodEnd,
      early_renewal: stillValid,
    });
  } catch (e: any) {
    // Se a licença falhou, o histórico recém-criado é removido para não deixar
    // registro de um período que não foi aplicado.
    if (admin && createdPeriodId) {
      await admin.from("worker_access_periods").delete().eq("id", createdPeriodId).then(() => {}, () => {});
    }
    return json(500, { error: e?.message || String(e) });
  }
});
