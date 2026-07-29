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
