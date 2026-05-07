import { useLocation } from "react-router-dom";
import { Eye, Shield, Layers, X } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useWorkerFilter } from "@/hooks/useWorkerFilter";
import { toast } from "sonner";

/**
 * Indicador visual de contexto para admin / super_admin.
 * Mostra se a visão é consolidada, ou se está filtrada por admin / trabalhador.
 * Aparece em telas operacionais (Rota, Caixa, Clientes, Empréstimos, Relatórios e similares).
 */
const SCOPE_PATHS = [
  "/", "/caixa", "/clients", "/active-loans", "/reports",
  "/overdue", "/today-summary", "/payment-history", "/cash-history",
  "/daily-cash-history", "/new-loan",
];

function shouldShow(pathname: string): boolean {
  if (SCOPE_PATHS.includes(pathname)) return true;
  if (pathname.startsWith("/clients/")) return true;
  if (pathname.startsWith("/loans/")) return true;
  return false;
}

export default function ScopeIndicator() {
  const { isAdmin, isSuperAdmin } = useAuth();
  const { selectedWorkerId, selectedWorkerName, selectedAdminId, selectedAdminName, setSelectedWorkerId, setSelectedAdminId } = useWorkerFilter();
  const location = useLocation();

  if (!isAdmin) return null;
  if (!shouldShow(location.pathname)) return null;

  const hasWorker = !!selectedWorkerId;
  const hasAdmin = !!selectedAdminId;
  const consolidated = !hasWorker && !hasAdmin;

  return (
    <div className="sticky top-14 z-30 border-b bg-card/95 backdrop-blur px-3 py-1.5 text-[11px] flex items-center gap-2 flex-wrap">
      {consolidated ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2 py-0.5 font-medium">
          <Layers className="h-3 w-3" />
          Modo: Consolidado {isSuperAdmin ? "(sistema)" : "(equipe)"}
        </span>
      ) : (
        <>
          {hasAdmin && (
            <span className="inline-flex items-center gap-1 rounded-full bg-accent/40 text-foreground px-2 py-0.5">
              <Shield className="h-3 w-3" />
              Admin: <strong>{selectedAdminName ?? "—"}</strong>
              <button
                onClick={() => { setSelectedAdminId(null); toast.success("Filtro de admin removido"); }}
                className="ml-1 rounded-full hover:bg-background/60 p-0.5"
                aria-label="Limpar filtro de admin"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
          {hasWorker && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 text-foreground px-2 py-0.5">
              <Eye className="h-3 w-3 text-warning" />
              Trabalhador: <strong>{selectedWorkerName ?? "—"}</strong>
              <button
                onClick={() => { setSelectedWorkerId(null); toast.success("Filtro de trabalhador removido"); }}
                className="ml-1 rounded-full hover:bg-background/60 p-0.5"
                aria-label="Limpar filtro de trabalhador"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
        </>
      )}
    </div>
  );
}
