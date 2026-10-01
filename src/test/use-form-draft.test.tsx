import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

let userId = "u1";
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: userId } }) }));

import { useFormDraft, clearAllDraftsForUser } from "@/hooks/useFormDraft";

const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;
const keys = () => Object.keys(sessionStorage).filter((k) => k.startsWith("upcred:draft:v2:"));

function hide() {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}
function show() {
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useFormDraft", () => {
  beforeEach(() => { sessionStorage.clear(); localStorage.clear(); userId = "u1"; show(); });

  it("salva ao ocultar e restaura na reconstrução", () => {
    const h = renderHook(({ v }) => useFormDraft("f", v), { wrapper, initialProps: { v: { name: "Ana" } } });
    act(() => hide());
    expect(keys()).toHaveLength(1);
    h.unmount(); // reconstrução enquanto oculto: mantém
    expect(keys()).toHaveLength(1);
    const raw = JSON.parse(sessionStorage.getItem(keys()[0])!);
    expect(raw.data.name).toBe("Ana");
  });

  it("navegação interna (desmonte visível) apaga o rascunho", () => {
    const h = renderHook(() => useFormDraft("f", { name: "Ana" }), { wrapper });
    act(() => { hide(); show(); });
    expect(keys()).toHaveLength(1);
    h.unmount();
    expect(keys()).toHaveLength(0);
  });

  it("pageshow redefine o estado oculto (BFCache)", () => {
    const h = renderHook(() => useFormDraft("f", { name: "Ana" }), { wrapper });
    act(() => { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pageshow")); });
    h.unmount();
    expect(keys()).toHaveLength(0);
  });

  it("clear remove o rascunho da ação", () => {
    const h = renderHook(() => useFormDraft("f", { name: "Ana" }), { wrapper });
    act(() => hide());
    act(() => h.result.current.clear());
    expect(keys()).toHaveLength(0);
  });

  it("nunca salva senha ou token", () => {
    renderHook(() => useFormDraft("f", { name: "A", password: "x", token: "t" }), { wrapper });
    act(() => hide());
    const raw = JSON.parse(sessionStorage.getItem(keys()[0])!);
    expect(raw.data).toEqual({ name: "A" });
  });

  it("separa usuários e logout limpa só o usuário correto", () => {
    renderHook(() => useFormDraft("f", { n: 1 }), { wrapper });
    act(() => hide());
    userId = "u2";
    renderHook(() => useFormDraft("f", { n: 2 }), { wrapper });
    act(() => hide());
    expect(keys()).toHaveLength(2);
    clearAllDraftsForUser("u1");
    expect(keys()).toHaveLength(1);
    expect(keys()[0]).toContain(":u2:");
  });

  it("formulários diferentes não se misturam", () => {
    renderHook(() => useFormDraft("a", { n: 1 }), { wrapper });
    renderHook(() => useFormDraft("b", { n: 2 }), { wrapper });
    act(() => hide());
    expect(keys().some((k) => k.includes(":a:"))).toBe(true);
    expect(keys().some((k) => k.includes(":b:"))).toBe(true);
  });
});
