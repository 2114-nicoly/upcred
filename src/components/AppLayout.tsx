import { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { DollarSign, Landmark, CalendarDays, Users, BarChart3, Wallet } from "lucide-react";

const navItems = [
  { path: "/", label: "Hoje", icon: DollarSign },
  { path: "/daily-cash-history", label: "Histórico", icon: CalendarDays },
  { path: "/active-loans", label: "Ativos", icon: Landmark },
  { path: "/caixa", label: "Caixa", icon: Wallet },
  { path: "/clients", label: "Clientes", icon: Users },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation();

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <main className="flex-1 overflow-auto pb-20">{children}</main>

      <nav className="fixed bottom-0 left-0 right-0 z-50 border-t bg-card shadow-lg">
        <div className="mx-auto flex max-w-lg items-center justify-around">
          {navItems.map((item) => {
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
