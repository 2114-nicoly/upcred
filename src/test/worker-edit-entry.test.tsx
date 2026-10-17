import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";

// Tudo que o mock do backend precisa ver nasce dentro de vi.hoisted: os factories
// de vi.mock são içados para o topo do arquivo e não podem ler variáveis de módulo.
const { invoke, rpc, state, tableQuery } = vi.hoisted(() => {
  const superAdminRow = { id: "w1", nome: "Maria Silva", login_codigo: "1234", active: true, parent_admin_id: "a1", archived_at: null };
  const adminPanelRow = { ...superAdminRow, notas: "observação existente", synthetic_email: "w1234@upcred.local", created_at: "2026-01-01", auth_user_id: null };
  const adminRow = { id: "a1", nome: "Empresa X", email_real: "e@x.com", login_codigo: "9999", active: true, created_at: "2026-01-01", notas: null };
  // Quando a observação não pode ser lida, o salvamento deve omitir o campo em vez
  // de sobrescrever com vazio o valor guardado no banco.
  const state = { notasReadFails: false };
  const invoke = vi.fn(async () => ({ data: { ok: true } }));
  const rpc = vi.fn(async (name: string) => {
    if (name === "list_workers_by_admin") return { data: [superAdminRow] };
    if (name === "super_admin_list_admins") return { data: [adminRow] };
    if (name === "admin_list_workers") return { data: [adminPanelRow] };
    return { data: [] };
  });
  const tableQuery = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in", "order", "not", "gt", "gte", "lte", "limit", "ilike"]) q[m] = () => q;
    q.maybeSingle = () => Promise.resolve(
      table === "workers" && !state.notasReadFails ? { data: { notas: "observação guardada" } } : { data: null, error: { message: "sem acesso" } },
    );
    q.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [] }).then(resolve);
    return q;
  };
  return { invoke, rpc, state, tableQuery, superAdminRow, adminPanelRow };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc, from: tableQuery, functions: { invoke } },
}));

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ isAdmin: true, isSuperAdmin: true, adminId: "a1", loading: false }) }));
vi.mock("@/hooks/useWorkerFilter", () => ({
  useWorkerFilter: () => ({ workers: [], admins: [], setSelectedAdminId: vi.fn(), setSelectedWorkerId: vi.fn() }),
}));
vi.mock("@/hooks/useConfirm", () => ({ useConfirm: () => async () => true }));
vi.mock("@/lib/consolidated-stats", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/consolidated-stats")>();
  return { ...real, loadWorkersStats: async () => [] };
});
vi.mock("@/lib/access-control", () => ({
  EMPTY_ACCESS_MAPS: { licenseByWorker: {}, lastPeriodByWorker: {}, periodsByWorker: {}, controlByAdmin: {} },
  loadAccessMaps: async () => ({ licenseByWorker: {}, lastPeriodByWorker: {}, periodsByWorker: {}, controlByAdmin: {} }),
  isCompanyPaused: () => false,
  getEffectiveAccessStatus: () => "active",
  companyStatusLabel: () => "Ativa",
}));
vi.mock("@/lib/finance-totals", () => ({
  computeCoreTotals: () => ({ recebidoPrincipal: 0, multasRecebidas: 0, recebidoTotal: 0, emprestado: 0 }),
  fetchAvailableCashByWorker: async () => ({}),
}));
vi.mock("@/lib/audit-utils", () => ({
  logAction: vi.fn(), requireAudit: vi.fn(), getCurrentActorIdentity: () => ({}), AuditRequiredError: class extends Error {},
}));
vi.mock("@/components/AuditLogList", () => ({ default: () => null }));
vi.mock("@/components/RemindersAdminList", () => ({ default: () => null }));
vi.mock("@/components/AccessSection", () => ({ default: () => null }));
vi.mock("@/components/CredentialsDialog", () => ({ CredentialsDialog: () => null }));
vi.mock("@/components/panel/PanelSummary", () => ({ FinancialDetails: () => null, WorkerSummaryList: () => null }));
vi.mock("@/components/access/WorkerRequestsAdminSection", () => ({ default: () => null }));
vi.mock("@/components/access/AccessHistoryDialog", () => ({ default: () => null }));
vi.mock("@/components/access/WorkerAccessSummary", () => ({ default: () => null }));
vi.mock("@/components/access/AccessStatusBadge", () => ({ default: () => null }));
vi.mock("@/components/CashReopenRequestsPanel", () => ({
  default: () => null,
  useCashReopenRequests: () => ({ requests: [], loading: false, busyId: null, count: 0, refresh: vi.fn(), review: vi.fn() }),
}));

import AdminFullPanel from "@/components/AdminFullPanel";
import AdminPanelPage from "@/pages/AdminPanelPage";

function Destination() {
  return <output aria-label="destino">{useLocation().pathname}</output>;
}

afterEach(() => { cleanup(); invoke.mockClear(); state.notasReadFails = false; });

// As abas são Radix com ativação automática: é o foco que seleciona a aba.
async function openTab(name: string) {
  const tab = await screen.findByRole("tab", { name });
  fireEvent.mouseDown(tab);
  fireEvent.focus(tab);
  fireEvent.click(tab);
}

describe("botão Editar ao lado do nome do trabalhador", () => {
  it("abre o trabalhador na rota existente do Admin sem tornar o nome clicável", async () => {
    render(<MemoryRouter><AdminPanelPage /><Destination /></MemoryRouter>);
    await openTab("Equipe");
    fireEvent.click(await screen.findByText("Maria Silva"));
    expect(screen.getByLabelText("destino")).toHaveTextContent(/^\/$/);
    fireEvent.click(screen.getByRole("button", { name: "Ver detalhes" }));
    expect(screen.getByLabelText("destino")).toHaveTextContent("/admin/worker/w1");
  });

  it("abre o trabalhador na rota existente do Super Admin", async () => {
    render(<MemoryRouter><AdminFullPanel adminId="a1" /><Destination /></MemoryRouter>);
    await openTab("Equipe");
    fireEvent.click(await screen.findByText("Maria Silva"));
    expect(screen.getByLabelText("destino")).toHaveTextContent(/^\/$/);
    fireEvent.click(screen.getByRole("button", { name: "Ver detalhes" }));
    expect(screen.getByLabelText("destino")).toHaveTextContent("/super-admin/worker/w1");
  });
  it("abre o modal de edição direto na lista do Super Admin e não sobrescreve a observação não lida", async () => {
    state.notasReadFails = true;
    render(<MemoryRouter><AdminFullPanel adminId="a1" /></MemoryRouter>);
    await openTab("Equipe");
    await screen.findByText("Maria Silva");
    fireEvent.click(await screen.findByRole("button", { name: "Editar Maria Silva" }));
    const nome = await screen.findByLabelText("Nome");
    expect(nome).toHaveValue("Maria Silva");
    expect(screen.getByLabelText("Login (4 dígitos)")).toHaveValue("1234");
    fireEvent.change(nome, { target: { value: "Maria S. Silva" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith("admin-edit-worker", {
      body: { worker_id: "w1", nome: "Maria S. Silva", login_codigo: "1234", active: true },
    });
  });

  it("abre o modal de edição direto na aba Equipe do Admin, com a observação existente preenchida", async () => {
    render(<MemoryRouter><AdminPanelPage /></MemoryRouter>);
    await openTab("Equipe");
    await screen.findByText("Maria Silva");
    const btn = await screen.findByRole("button", { name: "Editar Maria Silva" });
    expect(btn.closest("div")?.textContent).toContain("Maria Silva");
    fireEvent.click(btn);
    const nome = await screen.findByLabelText("Nome");
    expect(nome).toHaveValue("Maria Silva");
    expect(screen.getByLabelText("Observação")).toHaveValue("observação existente");
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith("admin-edit-worker", {
      body: { worker_id: "w1", nome: "Maria Silva", login_codigo: "1234", notas: "observação existente", active: true },
    });
  });
});
