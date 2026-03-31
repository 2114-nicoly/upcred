import { ReactNode, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { MapPin, Wallet, Menu, X, Users, Landmark, CalendarDays, BarChart3, Shield, Home } from "lucide-react";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

const bottomNavItems = [
  { path: "/", label: "Rota", icon: MapPin },
  { path: "/caixa", label: "Caixa", icon: Wallet },
];

const sidebarItems = [
  { path: "/", label: "Rota", icon: MapPin },
  { path: "/caixa", label: "Caixa", icon: Wallet },
  { path: "/clients", label: "Clientes", icon: Users },
  { path: "/active-loans", label: "Empréstimos Ativos", icon: Landmark },
  { path: "/daily-cash-history", label: "Histórico", icon: CalendarDays },
  { path: "/reports", label: "Relatórios", icon: BarChart3 },
  { path: "/admin", label: "Administrador", icon: Shield },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [open, setOpen] = useState(false);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Top header with sidebar trigger */}
      <header className="sticky top-0 z-40 flex h-12 items-center border-b bg-card px-3 shadow-sm">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <button className="mr-3 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
              <Menu className="h-5 w-5" />
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
        <span className="text-sm font-semibold text-foreground">
          {sidebarItems.find((i) => i.path === location.pathname)?.label ?? ""}
        </span>
      </header>

      <main className="flex-1 overflow-auto pb-20">{children}</main>

      {/* Bottom nav — only Rota and Caixa */}
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
