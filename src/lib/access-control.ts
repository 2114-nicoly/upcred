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
  | "paused"
  | "expired"
  | "expiring"
  | "active"
  | "scheduled";

export const ACCESS_STATUS_LABEL: Record<AccessStatus, string> = {
  unconfigured: "Não configurado",
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
  { value: "paused", label: "Pausado" },
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

/* ---------------- consultas ---------------- */

/** enforcement_enabled — sempre false quando não puder ser carregado. */
export async function fetchEnforcementEnabled(): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("access_control_settings")
      .select("enforcement_enabled")
      .limit(1)
      .maybeSingle();
    if (error || !data) return false;
    return !!data.enforcement_enabled;
  } catch {
    return false;
  }
}

export async function fetchCompanyControls(): Promise<CompanyAccessControl[]> {
  const { data } = await supabase
    .from("company_access_controls")
    .select("id, admin_id, manual_status, pause_reason, paused_at");
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
  if (!control) return "Não configurado";
  return control.manual_status === "paused" ? "Pausado" : "Ativo";
}
