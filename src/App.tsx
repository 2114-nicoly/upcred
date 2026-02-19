import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import AppLayout from "@/components/AppLayout";
import TodayPage from "@/pages/TodayPage";
import ClientsPage from "@/pages/ClientsPage";
import ClientDetailPage from "@/pages/ClientDetailPage";
import NewLoanPage from "@/pages/NewLoanPage";
import LoanDetailPage from "@/pages/LoanDetailPage";
import PaymentHistoryPage from "@/pages/PaymentHistoryPage";
import ActiveLoansPage from "@/pages/ActiveLoansPage";
import ReportsPage from "@/pages/ReportsPage";
import OverdueLoansPage from "@/pages/OverdueLoansPage";
import TodaySummaryPage from "@/pages/TodaySummaryPage";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AppLayout>
          <Routes>
            <Route path="/" element={<TodayPage />} />
            <Route path="/clients" element={<ClientsPage />} />
            <Route path="/clients/:clientId" element={<ClientDetailPage />} />
            <Route path="/clients/:clientId/new-loan" element={<NewLoanPage />} />
            <Route path="/loans/:loanId" element={<LoanDetailPage />} />
            <Route path="/active-loans" element={<ActiveLoansPage />} />
            <Route path="/overdue" element={<OverdueLoansPage />} />
            <Route path="/today-summary" element={<TodaySummaryPage />} />
            <Route path="/payment-history" element={<PaymentHistoryPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AppLayout>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
