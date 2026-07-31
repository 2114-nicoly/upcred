import { supabase } from "@/integrations/supabase/client";

/**
 * Base PASSIVA de controle de acessos e mensalidades.
 * Nesta etapa nada aqui bloqueia login, navegação ou operações — os status
 * calculados são exclusivamente informativos (exibição).
 */

export type ManualStatus = "active" | "paused";

export type CompanyAccessControl = {
  id: string;
  admin_id: string;
  manual_status: ManualStatus;
  pause_reason: string | null;
  paused_at: string | null;
  paused_by: string | null;
};

export type WorkerAccessLicense = {
  id: string;
  worker_id: string;
  admin_id: string | null;
  monthly_price: number | null;
  access_start: string | null;
  access_end: string | null;
  manual_status: ManualStatus;
  pause_reason: string | null;
  paused_at: string | null;
  paused_by: string | null;
};

export type WorkerAccessPeriod = {
  id: string;
  worker_id: string;
  admin_id: string | null;
  period_start: string | null;
  period_end: string | null;
  amount_paid: number | null;
  paid_at: string | null;
  months_granted: number | null;
  payment_method: string | null;
  notes: string | null;
  granted_by: string | null;
  created_at: string;
};

export type AccessStatus =
  | "unconfigured"
  | "company_paused"
  | "paused"
  | "expired"
  | "expiring"
  | "active"
  | "scheduled";

export const ACCESS_STATUS_LABEL: Record<AccessStatus, string> = {
  unconfigured: "Não configurado",
  company_paused: "Empresa pausada",
  paused: "Pausado",
  expired: "Expirado",
  expiring: "Vence em breve",
  active: "Ativo",
  scheduled: "Agendado",
};

export const ACCESS_STATUS_FILTERS: { value: AccessStatus | "all"; label: string }[] = [
  { value: "all", label: "Todas" },
  { value: "unconfigured", label: "Não configurado" },
  { value: "active", label: "Ativo" },
  { value: "expiring", label: "Vence em breve" },
  { value: "expired", label: "Expirado" },
  { value: "scheduled", label: "Agendado" },
  { value: "paused", label: "Pausado" },
  { value: "company_paused", label: "Empresa pausada" },
];


/* ---------------- datas locais (sem deslocamento de fuso) ---------------- */

/** Converte "YYYY-MM-DD" em Date local ao meio-dia (evita virada de dia por UTC). */
export function parseLocalDate(value?: string | null): Date | null {
  if (!value) return null;
  const [y, m, d] = value.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

function todayLocal(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate(), 12, 0, 0, 0);
}

export function formatAccessDate(value?: string | null): string {
  const d = parseLocalDate(value);
  if (!d) return "Não configurado";
  return d.toLocaleDateString("pt-BR");
}

export function formatDateTime(value?: string | null): string {
  if (!value) return "Não configurado";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "Não configurado";
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatMoney(value?: number | null): string {
  if (value == null) return "Não definido";
  return Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/** Dias restantes até access_end (0 = vence hoje). null quando não há data. */
export function daysRemaining(license?: WorkerAccessLicense | null): number | null {
  const end = parseLocalDate(license?.access_end);
  if (!end) return null;
  const diff = end.getTime() - todayLocal().getTime();
  return Math.round(diff / 86400000);
}

/** Status SOMENTE para exibição — nunca usado para bloquear acesso. */
export function getAccessStatus(license?: WorkerAccessLicense | null): AccessStatus {
  if (!license) return "unconfigured";
  if (license.manual_status === "paused") return "paused";
  const start = parseLocalDate(license.access_start);
  const end = parseLocalDate(license.access_end);
  if (!start && !end) return "unconfigured";
  const today = todayLocal();
  // Prioridade: pausado > expirado > agendado > vence em breve > ativo.
  // access_end é o último dia válido (não vence durante o próprio dia).
  const days = end ? Math.round((end.getTime() - today.getTime()) / 86400000) : null;
  if (days != null && days < 0) return "expired";
  if (start && start.getTime() > today.getTime()) return "scheduled";
  if (days == null) return "active";
  if (days <= 7) return "expiring";
  return "active";
}

/**
 * Status EXIBIDO do trabalhador, com a prioridade oficial:
 * Empresa pausada > Pausado > Expirado > Agendado > Vence em breve > Ativo > Não configurado.
 * Nunca altera o status armazenado na licença individual.
 */
export function getEffectiveAccessStatus(
  license?: WorkerAccessLicense | null,
  companyPaused?: boolean | null,
): AccessStatus {
  if (companyPaused) return "company_paused";
  return getAccessStatus(license);
}

/* ---------------- consultas ---------------- */

/** Estado do bloqueio automático; `error` quando não foi possível confirmar. */
export type EnforcementState = { enabled: boolean; error: boolean };

export async function fetchEnforcementState(): Promise<EnforcementState> {
  try {
    const { data, error } = await supabase
      .from("access_control_settings")
      .select("enforcement_enabled")
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("Falha ao consultar enforcement_enabled:", error);
      return { enabled: false, error: true };
    }
    if (!data) return { enabled: false, error: true };
    return { enabled: !!data.enforcement_enabled, error: false };
  } catch (e) {
    console.error("Falha ao consultar enforcement_enabled:", e);
    return { enabled: false, error: true };
  }
}

/** enforcement_enabled — sempre false quando não puder ser carregado. */
export async function fetchEnforcementEnabled(): Promise<boolean> {
  return (await fetchEnforcementState()).enabled;
}

/** Liga/desliga o bloqueio automático (somente SuperAdministrador via RLS). */
export async function setEnforcementEnabled(enabled: boolean, userId?: string | null): Promise<void> {
  const { data, error: selErr } = await supabase
    .from("access_control_settings")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (selErr) throw selErr;
  if (!data?.id) throw new Error("Configuração de acesso não encontrada.");
  const { error } = await supabase
    .from("access_control_settings")
    .update({ enforcement_enabled: enabled, updated_at: new Date().toISOString(), updated_by: userId ?? null })
    .eq("id", data.id);
  if (error) throw error;
}


export async function fetchCompanyControls(): Promise<CompanyAccessControl[]> {
  const { data } = await supabase
    .from("company_access_controls")
    .select("id, admin_id, manual_status, pause_reason, paused_at, paused_by");
  return ((data as any[]) ?? []) as CompanyAccessControl[];
}

export async function fetchWorkerLicenses(): Promise<WorkerAccessLicense[]> {
  const { data } = await supabase
    .from("worker_access_licenses")
    .select("id, worker_id, admin_id, monthly_price, access_start, access_end, manual_status, pause_reason, paused_at, paused_by");
  return ((data as any[]) ?? []) as WorkerAccessLicense[];
}

export async function fetchWorkerPeriods(): Promise<WorkerAccessPeriod[]> {
  const { data } = await supabase
    .from("worker_access_periods")
    .select("id, worker_id, admin_id, period_start, period_end, amount_paid, paid_at, months_granted, payment_method, notes, granted_by, created_at")
    .order("created_at", { ascending: false });
  return ((data as any[]) ?? []) as WorkerAccessPeriod[];
}

/** Nome de quem liberou o período (perfil), quando disponível. */
export async function fetchGrantorNames(ids: (string | null | undefined)[]): Promise<Record<string, string>> {
  const unique = Array.from(new Set(ids.filter(Boolean) as string[]));
  if (unique.length === 0) return {};
  const out: Record<string, string> = {};
  try {
    const { data } = await supabase
      .from("profiles")
      .select("user_id, display_name, email")
      .in("user_id", unique);
    ((data as any[]) ?? []).forEach((p) => {
      out[p.user_id] = p.display_name || p.email || "—";
    });
  } catch {
    /* somente exibição */
  }
  return out;
}

export const EMPTY_ACCESS_MAPS: AccessMaps = {
  licenseByWorker: {},
  lastPeriodByWorker: {},
  periodsByWorker: {},
  allPeriods: [],
  controlByAdmin: {},
};

export type AccessMaps = {
  licenseByWorker: Record<string, WorkerAccessLicense>;
  lastPeriodByWorker: Record<string, WorkerAccessPeriod>;
  periodsByWorker: Record<string, WorkerAccessPeriod[]>;
  allPeriods: WorkerAccessPeriod[];
  controlByAdmin: Record<string, CompanyAccessControl>;
};

/**
 * Carrega tudo que o usuário atual tem permissão de ver (RLS decide o escopo:
 * SuperAdmin = tudo, Administrador = própria empresa, Trabalhador = ele mesmo).
 */
export async function loadAccessMaps(): Promise<AccessMaps> {
  const [licenses, periods, controls] = await Promise.all([
    fetchWorkerLicenses(),
    fetchWorkerPeriods(),
    fetchCompanyControls(),
  ]);

  const licenseByWorker: Record<string, WorkerAccessLicense> = {};
  licenses.forEach((l) => { licenseByWorker[l.worker_id] = l; });

  // periods já vem ordenado do mais recente para o mais antigo
  const lastPeriodByWorker: Record<string, WorkerAccessPeriod> = {};
  const periodsByWorker: Record<string, WorkerAccessPeriod[]> = {};
  periods.forEach((p) => {
    if (!lastPeriodByWorker[p.worker_id]) lastPeriodByWorker[p.worker_id] = p;
    (periodsByWorker[p.worker_id] ||= []).push(p);
  });

  const controlByAdmin: Record<string, CompanyAccessControl> = {};
  controls.forEach((c) => { controlByAdmin[c.admin_id] = c; });

  return { licenseByWorker, lastPeriodByWorker, periodsByWorker, allPeriods: periods, controlByAdmin };

}

export function companyStatusLabel(control?: CompanyAccessControl | null): string {
  if (!control) return "Ativa";
  return control.manual_status === "paused" ? "Pausada" : "Ativa";
}

export function isCompanyPaused(control?: CompanyAccessControl | null): boolean {
  return control?.manual_status === "paused";
}

/* ---------------- verificação central de acesso ---------------- */

export type AccessCheck = {
  allowed: boolean;
  reason: string | null;
  status: AccessStatus | null;
  workerId: string | null;
  accessEnd: string | null;
  enforcementEnabled: boolean;
  /** Empresa vinculada com acesso pausado (informativo mesmo sem bloqueio). */
  companyPaused: boolean;
};

/** Mensagens exibidas ao usuário bloqueado (sem detalhes internos). */
export const ACCESS_BLOCK_MESSAGE: Record<string, string> = {
  paused: "Seu acesso está pausado no momento. Em caso de dúvidas, entre em contato com a empresa responsável.",
  expired: "Seu período de acesso venceu e precisa ser renovado. Entre em contato com a empresa responsável.",
  unconfigured: "Seu acesso ainda não foi liberado.",
  scheduled: "Seu período de acesso ainda não começou.",

};

export const COMPANY_PAUSED_MESSAGE =
  "Esta empresa está atualmente inativa no sistema. Em caso de dúvidas, entre em contato com o responsável.";

/**
 * Situação da empresa do próprio usuário (RLS libera apenas a própria empresa).
 * Quando `adminId` é conhecido, a consulta é restrita a ele — nunca observa outra empresa.
 * Falha de consulta nunca bloqueia: a empresa é considerada ativa.
 */
export async function fetchOwnCompanyPaused(adminId?: string | null): Promise<boolean> {
  try {
    let query = supabase
      .from("company_access_controls")
      .select("manual_status");
    if (adminId) query = query.eq("admin_id", adminId);
    const { data, error } = await query.limit(1).maybeSingle();
    if (error) {
      console.error("Falha ao consultar situação da empresa:", error);
      return false;
    }
    return (data as any)?.manual_status === "paused";
  } catch (e) {
    console.error("Falha ao consultar situação da empresa:", e);
    return false;
  }
}


/**
 * Verificação central de acesso.
 * SuperAdministrador sempre permitido. Administrador e trabalhador são bloqueados
 * quando o bloqueio automático está ativado e a empresa está pausada; o trabalhador
 * também depende da própria licença individual.
 */
export async function checkWorkerAccess(userId: string): Promise<AccessCheck> {
  const enforcementEnabled = await fetchEnforcementEnabled();
  const base: AccessCheck = {
    allowed: true,
    reason: null,
    status: null,
    workerId: null,
    accessEnd: null,
    enforcementEnabled,
    companyPaused: false,
  };
  if (!userId) return base;

  try {
    const [{ data: roles }, { data: workerRow }] = await Promise.all([
      supabase.from("user_roles").select("role").eq("user_id", userId),
      supabase.from("workers").select("id").eq("auth_user_id", userId).maybeSingle(),
    ]);
    const roleNames = ((roles as any[]) ?? []).map((r) => r.role as string);
    if (roleNames.includes("super_admin")) return base;

    // Empresa sem registro em company_access_controls é considerada ativa.
    const companyPaused = await fetchOwnCompanyPaused();
    const companyBlocked = enforcementEnabled && companyPaused;

    if (roleNames.includes("admin")) {
      return {
        ...base,
        companyPaused,
        allowed: !companyBlocked,
        reason: companyBlocked ? COMPANY_PAUSED_MESSAGE : null,
      };
    }

    const workerId = ((workerRow as any)?.id as string | undefined) ?? null;
    if (!workerId) {
      return { ...base, companyPaused, allowed: !companyBlocked, reason: companyBlocked ? COMPANY_PAUSED_MESSAGE : null };
    }

    const { data: licRow } = await supabase
      .from("worker_access_licenses")
      .select("id, worker_id, admin_id, monthly_price, access_start, access_end, manual_status, pause_reason, paused_at, paused_by")
      .eq("worker_id", workerId)
      .maybeSingle();
    const license = (licRow as any as WorkerAccessLicense | null) ?? null;
    const status = license ? getAccessStatus(license) : "unconfigured";
    const accessEnd = license?.access_end ?? null;

    if (!enforcementEnabled) {
      return { ...base, status, workerId, accessEnd, companyPaused };
    }

    if (companyPaused) {
      return { ...base, status, workerId, accessEnd, companyPaused, allowed: false, reason: COMPANY_PAUSED_MESSAGE };
    }

    // Bloqueia apenas pausado, expirado ou ainda não iniciado.
    // Trabalhador sem licença (unconfigured) continua acessando por compatibilidade.
    const blocked = status === "paused" || status === "expired" || status === "scheduled";
    return {
      allowed: !blocked,
      reason: blocked ? (ACCESS_BLOCK_MESSAGE[status] ?? null) : null,

      status,
      workerId,
      accessEnd,
      enforcementEnabled,
      companyPaused,
    };
  } catch (e) {
    // Falha de rede/consulta nunca bloqueia o usuário.
    console.error("Falha na verificação central de acesso:", e);
    return base;
  }
}

