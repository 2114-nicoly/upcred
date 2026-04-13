import { useState } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import AppLayout from "@/components/AppLayout";
import { ErrorBoundary, PageErrorBoundary } from "@/components/ErrorBoundary";
import DailyCashPage from "@/pages/DailyCashPage";
import DailyCashHistoryPage from "@/pages/DailyCashHistoryPage";
import ClientsPage from "@/pages/ClientsPage";
import ClientDetailPage from "@/pages/ClientDetailPage";
import NewLoanPage from "@/pages/NewLoanPage";
import LoanDetailPage from "@/pages/LoanDetailPage";
import PaymentHistoryPage from "@/pages/PaymentHistoryPage";
import ActiveLoansPage from "@/pages/ActiveLoansPage";
import ReportsPage from "@/pages/ReportsPage";
import OverdueLoansPage from "@/pages/OverdueLoansPage";
import TodaySummaryPage from "@/pages/TodaySummaryPage";
import LoginPage from "@/pages/LoginPage";
import NotFound from "./pages/NotFound";
import UnpaidInstallmentsPage from "@/pages/UnpaidInstallmentsPage";
import LoanOverdueDetailPage from "@/pages/LoanOverdueDetailPage";
import NewLoanSelectClientPage from "@/pages/NewLoanSelectClientPage";
import CaixaPage from "@/pages/CaixaPage";
import CashHistoryPage from "@/pages/CashHistoryPage";
import AdminPage from "@/pages/AdminPage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function WrappedRoute({ element }: { element: React.ReactNode }) {
  return <PageErrorBoundary>{element}</PageErrorBoundary>;
}

const App = () => {
  const [authenticated, setAuthenticated] = useState(
    () => localStorage.getItem("authenticated") === "true"
  );

  if (!authenticated) {
    return (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <ErrorBoundary>
            <LoginPage onLogin={() => setAuthenticated(true)} />
          </ErrorBoundary>
        </TooltipProvider>
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <ErrorBoundary>
            <AppLayout>
              <Routes>
                <Route path="/" element={<WrappedRoute element={<DailyCashPage />} />} />
                <Route path="/daily-cash-history" element={<WrappedRoute element={<DailyCashHistoryPage />} />} />
                <Route path="/clients" element={<WrappedRoute element={<ClientsPage />} />} />
                <Route path="/clients/:clientId" element={<WrappedRoute element={<ClientDetailPage />} />} />
                <Route path="/clients/:clientId/new-loan" element={<WrappedRoute element={<NewLoanPage />} />} />
                <Route path="/loans/:loanId" element={<WrappedRoute element={<LoanDetailPage />} />} />
                <Route path="/loans/:loanId/unpaid" element={<WrappedRoute element={<UnpaidInstallmentsPage />} />} />
                <Route path="/loans/:loanId/overdue" element={<WrappedRoute element={<LoanOverdueDetailPage />} />} />
                <Route path="/new-loan" element={<WrappedRoute element={<NewLoanSelectClientPage />} />} />
                <Route path="/active-loans" element={<WrappedRoute element={<ActiveLoansPage />} />} />
                <Route path="/overdue" element={<WrappedRoute element={<OverdueLoansPage />} />} />
                <Route path="/today-summary" element={<WrappedRoute element={<TodaySummaryPage />} />} />
                <Route path="/payment-history" element={<WrappedRoute element={<PaymentHistoryPage />} />} />
                <Route path="/caixa" element={<WrappedRoute element={<CaixaPage />} />} />
                <Route path="/cash-history" element={<WrappedRoute element={<CashHistoryPage />} />} />
                <Route path="/reports" element={<WrappedRoute element={<ReportsPage />} />} />
                <Route path="/admin" element={<WrappedRoute element={<AdminPage />} />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </AppLayout>
          </ErrorBoundary>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
