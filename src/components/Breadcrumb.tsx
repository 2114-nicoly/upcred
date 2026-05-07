import { Link, useLocation, useParams } from "react-router-dom";
import { ChevronRight, Home } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useWorkerFilter } from "@/hooks/useWorkerFilter";

type Crumb = { label: string; to?: string };

/**
 * Breadcrumb hierárquico baseado na rota e no escopo selecionado
 * (admin/trabalhador). Aparece somente para admin/super_admin em
 * páginas internas.
 */
export default function Breadcrumb() {
  const { isAdmin, isSuperAdmin } = useAuth();
  const { selectedAdminName, selectedAdminId, selectedWorkerName, selectedWorkerId } = useWorkerFilter();
  const location = useLocation();
  const params = useParams();

  if (!isAdmin) return null;

  const path = location.pathname;
  // Esconde em telas raiz puras
  const hideOn = new Set(["/", "/admin", "/super-admin"]);
  if (hideOn.has(path)) return null;

  const crumbs: Crumb[] = [];
  const root: Crumb = isSuperAdmin
    ? { label: "Super Admin", to: "/super-admin" }
    : { label: "Admin", to: "/admin" };
  crumbs.push(root);

  if (isSuperAdmin && selectedAdminId && selectedAdminName) {
    crumbs.push({ label: selectedAdminName, to: `/super-admin/${selectedAdminId}` });
  }
  if (selectedWorkerId && selectedWorkerName) {
    crumbs.push({ label: selectedWorkerName, to: `/admin/worker/${selectedWorkerId}` });
  }

  // Página atual
  const labelMap: Record<string, string> = {
    "/clients": "Clientes",
    "/active-loans": "Empréstimos",
    "/overdue": "Atrasados",
    "/caixa": "Caixa",
    "/cash-history": "Histórico Caixa",
    "/payment-history": "Pagamentos",
    "/reports": "Relatórios",
    "/workers": "Trabalhadores",
    "/admin-tools": "Manutenção",
    "/today-summary": "Resumo do Dia",
    "/daily-cash-history": "Histórico Diário",
    "/new-loan": "Novo Empréstimo",
  };
  let current = labelMap[path];
  if (!current) {
    if (path.startsWith("/clients/")) current = "Cliente";
    else if (path.startsWith("/loans/")) current = "Empréstimo";
    else if (path.startsWith("/admin/worker/") || path.startsWith("/super-admin/worker/")) current = selectedWorkerName ?? "Trabalhador";
    else if (path.startsWith("/super-admin/")) current = selectedAdminName ?? "Administrador";
  }
  if (current) crumbs.push({ label: current });

  if (crumbs.length <= 1) return null;

  return (
    <nav
      aria-label="Breadcrumb"
      className="px-3 py-1 text-[11px] text-muted-foreground border-b bg-muted/30 flex items-center gap-1 overflow-x-auto whitespace-nowrap"
    >
      <Home className="h-3 w-3 shrink-0" />
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={i} className="flex items-center gap-1 shrink-0">
            {i > 0 && <ChevronRight className="h-3 w-3 opacity-60" />}
            {c.to && !last ? (
              <Link to={c.to} className="hover:text-foreground hover:underline">
                {c.label}
              </Link>
            ) : (
              <span className={last ? "text-foreground font-medium" : ""}>{c.label}</span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
