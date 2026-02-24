import { useState } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import AppLayout from "@/components/AppLayout";
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

const queryClient = new QueryClient();

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
          <LoginPage onLogin={() => setAuthenticated(true)} />
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
          <AppLayout>
            <Routes>
              <Route path="/" element={<DailyCashPage />} />
              <Route path="/daily-cash-history" element={<DailyCashHistoryPage />} />
              <Route path="/clients" element={<ClientsPage />} />
              <Route path="/clients/:clientId" element={<ClientDetailPage />} />
              <Route path="/clients/:clientId/new-loan" element={<NewLoanPage />} />
              <Route path="/loans/:loanId" element={<LoanDetailPage />} />
              <Route path="/loans/:loanId/unpaid" element={<UnpaidInstallmentsPage />} />
              <Route path="/loans/:loanId/overdue" element={<LoanOverdueDetailPage />} />
              <Route path="/new-loan" element={<NewLoanSelectClientPage />} />
              <Route path="/active-loans" element={<ActiveLoansPage />} />
              <Route path="/overdue" element={<OverdueLoansPage />} />
              <Route path="/today-summary" element={<TodaySummaryPage />} />
              <Route path="/payment-history" element={<PaymentHistoryPage />} />
              <Route path="/caixa" element={<CaixaPage />} />
              <Route path="/cash-history" element={<CashHistoryPage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </AppLayout>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
