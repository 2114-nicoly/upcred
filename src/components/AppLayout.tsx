import { ReactNode, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { MapPin, Wallet, Menu, X, Users, Landmark, CalendarDays, BarChart3, Shield, Home, ArrowLeft } from "lucide-react";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

const bottomNavItems = [
  { path: "/", label: "Rota", icon: MapPin },
  { path: "/caixa", label: "Geral", icon: Wallet },
];

const sidebarItems = [
  { path: "/", label: "Rota", icon: MapPin },
  { path: "/caixa", label: "Geral", icon: Wallet },
  { path: "/clients", label: "Clientes", icon: Users },
  { path: "/active-loans", label: "Empréstimos Ativos", icon: Landmark },
  { path: "/daily-cash-history", label: "Histórico", icon: CalendarDays },
  { path: "/reports", label: "Relatórios", icon: BarChart3 },
  { path: "/admin", label: "Administrador", icon: Shield },
];

// Extended route labels for header (includes sub-pages)
const routeLabels: Record<string, string> = {
  "/": "Rota",
  "/caixa": "Caixa",
  "/clients": "Clientes",
  "/active-loans": "Empréstimos Ativos",
  "/daily-cash-history": "Histórico",
  "/reports": "Relatórios",
  "/admin": "Administrador",
  "/overdue": "Parcelas Atrasadas",
  "/today-summary": "Resumo do Dia",
  "/payment-history": "Histórico de Pagamentos",
  "/cash-history": "Histórico de Movimentações",
  "/new-loan": "Novo Empréstimo",
};

function getRouteLabel(pathname: string): string {
  if (routeLabels[pathname]) return routeLabels[pathname];
  if (pathname.startsWith("/clients/") && pathname.includes("/new-loan")) return "Novo Empréstimo";
  if (pathname.startsWith("/clients/")) return "Detalhes do Cliente";
  if (pathname.startsWith("/loans/") && pathname.includes("/unpaid")) return "Parcelas Pendentes";
  if (pathname.startsWith("/loans/") && pathname.includes("/overdue")) return "Parcelas Atrasadas";
  if (pathname.startsWith("/loans/")) return "Detalhes do Empréstimo";
  return "";
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const mainPages = ["/", "/caixa", "/clients", "/active-loans", "/daily-cash-history", "/reports", "/admin"];
  const isMainPage = mainPages.includes(location.pathname);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Top header */}
      <header className="sticky top-0 z-40 flex h-14 items-center border-b bg-card px-4 shadow-sm">
        {isMainPage ? (
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <button className="mr-4 rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
                <Menu className="h-6 w-6" />
              </button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-0">
              <div className="flex h-full flex-col">
                <div className="border-b px-4 py-4">
                  <h2 className="text-lg font-semibold text-foreground">Menu</h2>
                </div>
                <nav className="flex-1 space-y-1 px-2 py-3">
                  {sidebarItems.map((item) => {
                    const active = location.pathname === item.path;
                    return (
                      <Link
                        key={item.path + item.label}
                        to={item.path}
                        onClick={() => setOpen(false)}
                        className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                          active
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground"
                        }`}
                      >
                        <item.icon className="h-5 w-5" />
                        {item.label}
                      </Link>
                    );
                  })}
                </nav>
              </div>
            </SheetContent>
          </Sheet>
        ) : (
          <button
            onClick={() => navigate(-1)}
            className="mr-4 rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
        )}
        <span className="text-base font-bold text-foreground">
          {getRouteLabel(location.pathname)}
        </span>
      </header>

      <main className="flex-1 overflow-auto pb-20">{children}</main>

      {/* Bottom nav */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 border-t bg-card shadow-lg">
        <div className="mx-auto flex max-w-lg items-center justify-around">
          {bottomNavItems.map((item) => {
            const active = location.pathname === item.path;
            return (
              <Link
                key={item.path}
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