import { ReactNode, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { MapPin, Wallet, Menu, X, Users, Landmark, CalendarDays, BarChart3, Shield, Crown, ArrowLeft, LogOut, Eye, LayoutDashboard, ClipboardList, Wrench } from "lucide-react";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { useAuth } from "@/hooks/useAuth";
import { useWorkerFilter } from "@/hooks/useWorkerFilter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import ScopeIndicator from "@/components/ScopeIndicator";
import Breadcrumb from "@/components/Breadcrumb";
import { toast } from "sonner";

type NavItem = { path: string; label: string; icon: any };

// ============= MENU SETS PER ROLE =============
const workerBottomNav: NavItem[] = [
  { path: "/", label: "Rota", icon: MapPin },
  { path: "/caixa", label: "Geral", icon: Wallet },
];
const workerSidebar: NavItem[] = [
  { path: "/", label: "Rota", icon: MapPin },
  { path: "/caixa", label: "Geral", icon: Wallet },
  { path: "/clients", label: "Clientes", icon: Users },
  { path: "/active-loans", label: "Empréstimos Ativos", icon: Landmark },
  { path: "/daily-cash-history", label: "Histórico", icon: CalendarDays },
  { path: "/reports", label: "Relatórios", icon: BarChart3 },
];

const adminBottomNav: NavItem[] = [
  { path: "/admin", label: "Painel", icon: LayoutDashboard },
  { path: "/caixa", label: "Caixa Equipe", icon: Wallet },
];
const adminSidebar: NavItem[] = [
  { path: "/admin", label: "Painel (equipe)", icon: LayoutDashboard },
  { path: "/clients", label: "Clientes da Equipe", icon: Users },
  { path: "/active-loans", label: "Empréstimos da Equipe", icon: Landmark },
  { path: "/caixa", label: "Caixa da Equipe", icon: Wallet },
  { path: "/reports", label: "Relatórios", icon: BarChart3 },
  { path: "/admin-tools", label: "Manutenção", icon: Wrench },
];

const superAdminBottomNav: NavItem[] = [
  { path: "/super-admin", label: "Geral", icon: Crown },
  { path: "/caixa", label: "Caixa Geral", icon: Wallet },
];
const superAdminSidebar: NavItem[] = [
  { path: "/super-admin", label: "Dashboard Geral", icon: Crown },
  { path: "/workers", label: "Todos os Trabalhadores", icon: Users },
  { path: "/clients", label: "Clientes", icon: Users },
  { path: "/active-loans", label: "Empréstimos", icon: Landmark },
  { path: "/caixa", label: "Caixa Geral", icon: Wallet },
  { path: "/reports", label: "Relatórios Gerais", icon: BarChart3 },
  { path: "/admin-tools", label: "Manutenção", icon: Wrench },
];

// ============= HEADER LABELS PER ROLE =============
function buildRouteLabels(role: "worker" | "admin" | "super_admin"): Record<string, string> {
  const base: Record<string, string> = {
    "/": "Rota",
    "/clients": "Clientes",
    "/daily-cash-history": "Histórico",
    "/reports": "Relatórios",
    "/admin-tools": "Manutenção",
    "/workers": "Trabalhadores",
    "/overdue": "Parcelas Atrasadas",
    "/today-summary": "Resumo do Dia",
    "/payment-history": "Histórico de Pagamentos",
    "/cash-history": "Histórico de Movimentações",
    "/new-loan": "Novo Empréstimo",
  };
  if (role === "super_admin") {
    return {
      ...base,
      "/caixa": "Caixa Geral",
      "/active-loans": "Empréstimos",
      "/clients": "Clientes",
      "/reports": "Relatórios Gerais",
      "/admin": "Painel Admin",
      "/super-admin": "Dashboard Geral",
    };
  }
  if (role === "admin") {
    return {
      ...base,
      "/caixa": "Caixa da Equipe",
      "/active-loans": "Empréstimos da Equipe",
      "/clients": "Clientes da Equipe",
      "/admin": "Dashboard Admin",
    };
  }
  return { ...base, "/caixa": "Geral", "/active-loans": "Empréstimos Ativos" };
}

function getRouteLabel(pathname: string, labels: Record<string, string>): string {
  if (labels[pathname]) return labels[pathname];
  if (pathname.startsWith("/clients/") && pathname.includes("/new-loan")) return "Novo Empréstimo";
  if (pathname.startsWith("/clients/")) return "Detalhes do Cliente";
  if (pathname.startsWith("/loans/") && pathname.includes("/unpaid")) return "Parcelas Pendentes";
  if (pathname.startsWith("/loans/") && pathname.includes("/overdue")) return "Parcelas Atrasadas";
  if (pathname.startsWith("/loans/")) return "Detalhes do Empréstimo";
  if (pathname.startsWith("/admin/worker/")) return "Painel do Trabalhador";
  if (pathname.startsWith("/super-admin/")) return "Painel do Administrador";
  return "";
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, isAdmin, isSuperAdmin, signOut } = useAuth();
  const { selectedWorkerId, selectedWorkerName, setSelectedWorkerId } = useWorkerFilter();
  const [open, setOpen] = useState(false);

  const role: "worker" | "admin" | "super_admin" = isSuperAdmin ? "super_admin" : isAdmin ? "admin" : "worker";

  const bottomNav = role === "super_admin" ? superAdminBottomNav : role === "admin" ? adminBottomNav : workerBottomNav;
  const sidebarItems = role === "super_admin" ? superAdminSidebar : role === "admin" ? adminSidebar : workerSidebar;
  const labels = buildRouteLabels(role);

  const handleSignOut = async () => {
    await signOut();
    toast.success("Sessão encerrada");
    navigate("/auth", { replace: true });
  };

  // Root pages per role: where back falls back to and where menu shows instead of back
  const rootPath = role === "super_admin" ? "/super-admin" : role === "admin" ? "/admin" : "/";
  const rootPaths = new Set<string>([rootPath, ...bottomNav.map((i) => i.path)]);
  const isMainPage = rootPaths.has(location.pathname);

  const handleBack = () => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate(rootPath, { replace: true });
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-40 flex h-14 items-center border-b bg-card px-4 shadow-sm">
        {!isMainPage && (
          <button
            onClick={handleBack}
            aria-label="Voltar"
            className="mr-1 rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
        )}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <button aria-label="Abrir menu" className="mr-3 rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
              <Menu className="h-6 w-6" />
            </button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 p-0">
            <div className="flex h-full flex-col">
              <div className="border-b px-4 py-4">
                <h2 className="text-lg font-semibold text-foreground">Menu</h2>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {role === "super_admin" ? "Super Administrador" : role === "admin" ? "Administrador" : "Trabalhador"}
                </p>
              </div>
              <nav className="flex-1 space-y-1 px-2 py-3 overflow-y-auto">
                {sidebarItems.map((item, idx) => {
                  const active = location.pathname === item.path;
                  return (
                    <Link
                      key={`${item.path}-${item.label}-${idx}`}
                      to={item.path}
                      onClick={() => setOpen(false)}
                      className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                        active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                      }`}
                    >
                      <item.icon className="h-5 w-5" />
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
              <div className="border-t p-3 space-y-2">
                {user && (
                  <div className="px-2 py-1 text-xs text-muted-foreground">
                    <p className="truncate font-medium text-foreground">{user.email}</p>
                    {role === "super_admin" ? (
                      <p className="text-primary">Super Admin</p>
                    ) : role === "admin" ? (
                      <p className="text-primary">Administrador</p>
                    ) : (
                      <p>Trabalhador</p>
                    )}
                  </div>
                )}
                <Button variant="outline" size="sm" className="w-full" onClick={handleSignOut}>
                  <LogOut className="mr-2 h-4 w-4" /> Sair
                </Button>
              </div>
            </div>
          </SheetContent>
        </Sheet>
        <span className="text-base font-bold text-foreground">{getRouteLabel(location.pathname, labels)}</span>
        {isAdmin && (
          <div className="ml-auto flex items-center gap-1.5">
            {selectedWorkerId ? (
              <button
                onClick={() => setSelectedWorkerId(null)}
                className="flex items-center gap-1 text-[10px] bg-primary/10 text-primary rounded-full px-2 py-0.5 hover:bg-primary/20"
                title="Limpar filtro"
              >
                <Eye className="h-3 w-3" />
                <span className="truncate max-w-[120px]">{selectedWorkerName}</span>
                <X className="h-3 w-3" />
              </button>
            ) : (
              <Badge variant="outline" className="text-[10px] h-5">
                {role === "super_admin" ? "Sistema" : "Equipe"}
              </Badge>
            )}
            <Badge className="text-[10px] h-5">{role === "super_admin" ? "Super" : "Admin"}</Badge>
          </div>
        )}
      </header>

      <ScopeIndicator />
      <Breadcrumb />
      <main className="flex-1 overflow-auto pb-20">{children}</main>

      <nav className="fixed bottom-0 left-0 right-0 z-50 border-t bg-card shadow-lg">
        <div className="mx-auto flex max-w-lg items-center justify-around">
          {bottomNav.map((item) => {
            const active = location.pathname === item.path;
            return (
              <Link
                key={item.path + item.label}
                to={item.path}
                className={`flex flex-1 flex-col items-center gap-1 py-3 text-xs font-medium transition-colors ${
                  active ? "text-primary" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <item.icon className={`h-5 w-5 ${active ? "text-primary" : ""}`} />
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
