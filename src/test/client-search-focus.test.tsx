import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import ClientsPage from "@/pages/ClientsPage";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const query: Record<string, unknown> = {};
      for (const method of ["select", "is", "order", "not", "gt"]) query[method] = () => query;
      query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({
        data: table === "clients" ? [
          { id: "c1", name: "Nicoly", client_code: 1 },
          { id: "c2", name: "Ana", client_code: 2 },
        ] : [],
      }).then(resolve);
      return query;
    },
  },
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ isAdmin: false, isSuperAdmin: false }) }));
vi.mock("@/hooks/useWorkerFilter", () => ({ useWorkerFilter: () => ({ workers: [], admins: [] }) }));
vi.mock("@/hooks/useFormDraft", () => ({ useFormDraft: () => ({ restore: () => null, clear: vi.fn() }) }));
vi.mock("@/components/ClientForm", () => ({ default: () => null, emptyClientForm: {}, validateClientForm: vi.fn() }));
vi.mock("@/components/ClientAttachments", () => ({ default: () => null }));
vi.mock("@/components/PendingClientAttachments", () => ({ default: () => null }));
vi.mock("@/lib/attachment-upload", () => ({ uploadPendingAttachments: vi.fn() }));
vi.mock("@/lib/audit-utils", () => ({ logAction: vi.fn(), requireAudit: vi.fn(), AuditRequiredError: class extends Error {} }));

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output data-testid="location">{location.search}</output>
    <button onClick={() => navigate("/clients?q=Ana&tab=active")}>Restore URL</button></>;
}

afterEach(cleanup);
describe("continuous client search", () => {
  it("filters immediately, preserves focus and edits, and writes the URL only on blur", async () => {
    render(<MemoryRouter initialEntries={["/clients?tab=active"]}><ClientsPage /><LocationProbe /></MemoryRouter>);
    await screen.findByText("Nicoly");
    const input = screen.getByPlaceholderText("Buscar por nome, código, telefone ou documento...");
    input.focus();
    for (const value of ["n", "ni", "nic", "nicoly", "nicol", "zzzz", "Ana"]) {
      fireEvent.change(input, { target: { value } });
      expect(input).toHaveFocus();
      expect(input).toHaveValue(value);
      expect(screen.getByPlaceholderText("Buscar por nome, código, telefone ou documento...")).toBe(input);
      expect(screen.getByTestId("location")).toHaveTextContent("?tab=active");
    }
    expect(screen.queryByText("Nicoly")).not.toBeInTheDocument();
    expect(screen.getByText("Ana")).toBeInTheDocument();
    fireEvent.blur(input);
    expect(screen.getByTestId("location")).toHaveTextContent("?tab=active&q=Ana");
    input.focus();
    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveFocus();
    expect(screen.getByText("Nicoly")).toBeInTheDocument();
    expect(screen.getByText("Ana")).toBeInTheDocument();
    fireEvent.blur(input);
    expect(screen.getByTestId("location")).toHaveTextContent("?tab=active");
  });

  it("loads and restores search from external URL navigation", async () => {
    render(<MemoryRouter initialEntries={["/clients?q=Nicoly&tab=active"]}><ClientsPage /><LocationProbe /></MemoryRouter>);
    const input = screen.getByPlaceholderText("Buscar por nome, código, telefone ou documento...");
    expect(input).toHaveValue("Nicoly");
    await screen.findByText("Nicoly");
    expect(screen.queryByText("Ana")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Restore URL"));
    await waitFor(() => expect(input).toHaveValue("Ana"));
    expect(screen.queryByText("Nicoly")).not.toBeInTheDocument();
    expect(screen.getByText("Ana")).toBeInTheDocument();
  });
});