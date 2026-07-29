export type WorkerRequestStatus = "pending" | "processing" | "approved" | "rejected";

export type WorkerCreationRequest = {
  id: string;
  admin_id: string;
  requested_by: string | null;
  worker_name: string;
  notes: string | null;
  status: WorkerRequestStatus;
  requested_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  rejection_reason: string | null;
  created_worker_id: string | null;
  created_at: string;
  updated_at: string;
};

export function requestStatusLabel(status: WorkerRequestStatus): string {
  switch (status) {
    case "approved": return "Aceita";
    case "rejected": return "Negada";
    default: return "Em análise";
  }
}

export function requestStatusVariant(status: WorkerRequestStatus): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "approved": return "default";
    case "rejected": return "destructive";
    default: return "secondary";
  }
}

export function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

/** YYYY-MM-DD de hoje, em data local. */
export function todayLocalISO(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Soma meses de calendário a uma data local YYYY-MM-DD. */
export function addMonthsLocal(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const base = new Date(y, m - 1 + months, 1);
  const lastDay = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  const mm = String(base.getMonth() + 1).padStart(2, "0");
  const dd = String(Math.min(d, lastDay)).padStart(2, "0");
  return `${base.getFullYear()}-${mm}-${dd}`;
}

