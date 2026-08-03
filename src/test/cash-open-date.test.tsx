import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  getTodayCashDate,
  classifyCashDate,
  canOpenCashDate,
  openDailyCash,
  CASH_OPEN_FUTURE_MESSAGE,
  CASH_OPEN_PAST_MESSAGE,
} from "@/lib/cash-lock";
import OpenCashBanner from "@/components/OpenCashBanner";

const rpc = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: any[]) => rpc(...args),
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: "cash-id", error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("data do caixa no fuso America/Sao_Paulo", () => {
  it("usa o dia de São Paulo, não UTC", () => {
    // 2026-08-04T02:00:00Z => 03/08/2026 23:00 em São Paulo
    const now = new Date("2026-08-04T02:00:00Z");
    expect(getTodayCashDate(now)).toBe("2026-08-03");
  });

  it("classifica hoje, passado e futuro", () => {
    const now = new Date("2026-08-03T15:00:00Z");
    expect(classifyCashDate("2026-08-03", now)).toBe("today");
    expect(classifyCashDate("2026-08-02", now)).toBe("past");
    expect(classifyCashDate("2026-08-04", now)).toBe("future");
    expect(canOpenCashDate("2026-08-03", now)).toBe(true);
    expect(canOpenCashDate("2026-08-04", now)).toBe(false);
  });
});

describe("openDailyCash", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T15:00:00Z"));
  });

  it("trabalhador abre o próprio caixa hoje", async () => {
    await expect(openDailyCash("2026-08-03")).resolves.toBe("cash-id");
    expect(rpc).toHaveBeenCalledWith("open_daily_cash", { p_cash_date: "2026-08-03" });
  });

  it("administrador abre o caixa de um trabalhador hoje", async () => {
    await expect(openDailyCash("2026-08-03", "worker-1")).resolves.toBe("cash-id");
    expect(rpc).toHaveBeenCalledWith("open_daily_cash", {
      p_cash_date: "2026-08-03",
      p_worker_id: "worker-1",
    });
  });

  it("rejeita data futura sem chamar a RPC", async () => {
    await expect(openDailyCash("2026-08-04")).rejects.toThrow(CASH_OPEN_FUTURE_MESSAGE);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejeita data passada sem chamar a RPC", async () => {
    await expect(openDailyCash("2026-08-01")).rejects.toThrow(CASH_OPEN_PAST_MESSAGE);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("propaga erro do banco (caixa antigo fechado)", async () => {
    rpc.mockResolvedValue({ data: null, error: new Error("caixa deste dia já foi fechado") });
    await expect(openDailyCash("2026-08-03")).rejects.toThrow("caixa deste dia já foi fechado");
  });
});

describe("OpenCashBanner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T15:00:00Z"));
  });

  it("mostra o botão apenas na data atual", () => {
    render(<OpenCashBanner cashDate="2026-08-03" />);
    expect(screen.getByRole("button", { name: /Abrir Caixa do Dia/i })).toBeTruthy();
  });

  it("data passada: sem botão", () => {
    render(<OpenCashBanner cashDate="2026-08-01" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/Caixa não foi aberto nesta data/i)).toBeTruthy();
  });

  it("data futura: sem botão", () => {
    render(<OpenCashBanner cashDate="2026-08-10" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/só poderá ser aberto na própria data/i)).toBeTruthy();
  });

  it("admin visualizando trabalhador segue a mesma regra", () => {
    render(<OpenCashBanner cashDate="2026-08-01" workerId="worker-1" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
});
