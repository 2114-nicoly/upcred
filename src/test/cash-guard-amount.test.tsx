import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CashGuardProvider } from "@/components/CashGuardProvider";
import { showCashGuardModal } from "@/lib/cash-guard";

const { rpc, errorToast } = vi.hoisted(() => ({
  rpc: vi.fn().mockResolvedValue({ error: null }),
  errorToast: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: errorToast } }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ workerId: "w1", adminId: "a1" }) }));
vi.mock("@/hooks/useEffectiveScope", () => ({
  useEffectiveScope: () => ({ effectiveWorkerId: "w1", effectiveAdminId: "a1", readOnly: false }),
}));
vi.mock("@/lib/loan-cash", () => ({
  fetchScopedActiveCash: vi.fn().mockResolvedValue({ cashDate: "2026-10-16" }),
}));

async function openEntry(missing = 20.5) {
  render(<CashGuardProvider><span>Conteúdo</span></CashGuardProvider>);
  const { act } = await import("@testing-library/react");
  act(() => showCashGuardModal({ available_cash: 0, operation_amount: missing, missing_amount: missing }));
  fireEvent.click(await screen.findByRole("button", { name: "Adicionar dinheiro ao caixa" }));
  return screen.getByLabelText("Valor da entrada");
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("entrada monetária do modal de saldo insuficiente", () => {
  it.each([
    ["20,50", 20.5],
    ["1.080,50", 1080.5],
    ["0,50", 0.5],
    ["20.50", 20.5],
    ["2.000,00", 2000],
  ])("%s registra exatamente %s reais após confirmação", async (input, expected) => {
    const field = await openEntry();
    fireEvent.change(field, { target: { value: input } });
    fireEvent.click(screen.getByRole("button", { name: "Revisar entrada" }));
    expect(rpc).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: "Confirmar entrada" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(rpc).toHaveBeenCalledWith("register_manual_movement", expect.objectContaining({ p_amount: expected }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it.each([[20.5, "20,50"], [1080.5, "1.080,50"]])("preenche %s com duas casas brasileiras", async (missing, expected) => {
    expect(await openEntry(missing)).toHaveValue(expected);
  });

  it.each(["2.000", "1,080.50", "1.08,50", "20,500", "abc", "-20,50", "0", "1e3"])(
    "rejeita entrada inválida ou ambígua %s sem registrar", async (input) => {
      const field = await openEntry();
      fireEvent.change(field, { target: { value: input } });
      fireEvent.click(screen.getByRole("button", { name: "Revisar entrada" }));
      expect(errorToast).toHaveBeenCalledTimes(1);
      expect(rpc).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Confirmar entrada" })).not.toBeInTheDocument();
    },
  );
});