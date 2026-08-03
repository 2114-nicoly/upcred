import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Fechamento autoritativo: o snapshot é construído, validado e gravado PELO
 * BANCO. O navegador só envia data, dinheiro contado e observação.
 */

const rpc = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: any[]) => rpc(...args),
    from: () => {
      throw new Error("o fechamento não deve montar snapshot no navegador");
    },
  },
}));

const readSrc = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: { cash_id: "dc1", version: 1 }, error: null });
});

describe("closeDailyCashWithSnapshot — chamada da RPC", () => {
  it("não envia p_payload (nenhum snapshot vindo do navegador)", async () => {
    const { closeDailyCashWithSnapshot } = await import("@/lib/daily-snapshot");
    await closeDailyCashWithSnapshot("2026-08-03", 1234.5, "conferido");
    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0];
    expect(fn).toBe("close_daily_cash_with_snapshot");
    expect(Object.keys(args).sort()).toEqual(["p_cash_date", "p_counted", "p_note"]);
    expect(args).not.toHaveProperty("p_payload");
  });

  it("retorna cash_id e version da nova versão criada no banco", async () => {
    rpc.mockResolvedValue({ data: { cash_id: "dc9", version: 3 }, error: null });
    const { closeDailyCashWithSnapshot } = await import("@/lib/daily-snapshot");
    const res = await closeDailyCashWithSnapshot("2026-08-03", 10, null);
    expect(res).toEqual({ cash_id: "dc9", version: 3 });
  });

  it("falha no snapshot propaga erro (caixa continua aberto, sem sucesso)", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "Não foi possível congelar todas as informações. O caixa continua aberto." },
    });
    const { closeDailyCashWithSnapshot } = await import("@/lib/daily-snapshot");
    await expect(closeDailyCashWithSnapshot("2026-08-03", 10, null)).rejects.toMatchObject({
      message: expect.stringContaining("O caixa continua aberto"),
    });
  });

  it("escopo de outra empresa/trabalhador é rejeitado pelo banco", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "Não foi possível validar a empresa e o trabalhador deste caixa. O fechamento foi cancelado." },
    });
    const { closeDailyCashWithSnapshot } = await import("@/lib/daily-snapshot");
    await expect(closeDailyCashWithSnapshot("2026-08-03", 10, null)).rejects.toMatchObject({
      message: expect.stringContaining("fechamento foi cancelado"),
    });
  });
});

describe("gravação de snapshot pelo cliente está bloqueada", () => {
  it("saveDailyCashSnapshot lança erro explícito", async () => {
    const mod = await import("@/lib/daily-snapshot");
    await expect(mod.saveDailyCashSnapshot("2026-08-03", {} as any)).rejects.toThrow(
      mod.SNAPSHOT_CLIENT_SAVE_BLOCKED_MESSAGE,
    );
  });
});

describe("CaixaPage — fluxo de fechamento", () => {
  const src = readSrc("src/pages/CaixaPage.tsx");

  it("não usa buildDailyCashSnapshotPayload nem p_payload", () => {
    expect(src).not.toContain("buildDailyCashSnapshotPayload");
    expect(src).not.toContain("p_payload");
    expect(src).not.toContain("saveDailyCashSnapshot");
  });

  it("chama apenas a RPC oficial e informa que o caixa permaneceu aberto em erro", () => {
    expect(src).toContain("closeDailyCashWithSnapshot(selectedDate, counted");
    expect(src).toContain("O caixa permaneceu aberto.");
  });

  it("mostra sucesso somente depois da RPC", () => {
    const rpcIdx = src.indexOf("closeDailyCashWithSnapshot(selectedDate");
    const okIdx = src.indexOf('toast.success("Caixa fechado!")');
    expect(rpcIdx).toBeGreaterThan(0);
    expect(okIdx).toBeGreaterThan(rpcIdx);
  });

  it("mantém a leitura dos snapshots já salvos", () => {
    expect(src).toContain("loadDailyCashSnapshot");
    expect(src).toContain("listDailyCashSnapshotVersions");
  });
});
