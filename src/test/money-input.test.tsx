import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MoneyInput } from "@/components/MoneyInput";
import { formatMoneyInput, parseMoneyInput } from "@/lib/money-input";
import { validatePaymentAmount, createPaymentAmountState } from "@/lib/payment-amount";
import { parsePenaltyInput } from "@/lib/penalty-payment";

afterEach(cleanup);

describe("conversão única em reais", () => {
  it.each([
    ["20,50", 20.5, "20,50"], ["20.50", 20.5, "20,50"],
    ["1.080,50", 1080.5, "1.080,50"], ["R$ 1.250,75", 1250.75, "1.250,75"],
    ["1250,75", 1250.75, "1.250,75"], ["1.250,75", 1250.75, "1.250,75"],
    ["0,05", 0.05, "0,05"], ["2000", 2000, "2.000,00"], ["0,50", 0.5, "0,50"],
    ["2.000,00", 2000, "2.000,00"],
  ])("%s mantém exatamente %s reais", (raw, value, formatted) => {
    expect(parseMoneyInput(raw)).toBe(value);
    expect(formatMoneyInput(value)).toBe(formatted);
    expect(parsePenaltyInput(raw)).toBe(value);
    expect(validatePaymentAmount({ ...createPaymentAmountState(), mode: "manual", manualValue: raw }, 100, 20000).amount).toBe(value);
  });
  it.each(["2.000", "20,500", "20.500", "1,250.75", "1.25,75", "1e3", "NaN", "abc", "1 250,75", "20,", "", "9007199254740992"])(
    "rejeita %s sem arredondar ou presumir", (raw) => {
      expect(parseMoneyInput(raw)).toBeNull();
      expect(validatePaymentAmount({ ...createPaymentAmountState(), mode: "manual", manualValue: raw }, 100, 20000).valid).toBe(false);
    },
  );
  it("mantém valores assinados para ajustes sem liberar multa negativa", () => {
    expect(parseMoneyInput("-20,50")).toBe(-20.5);
    expect(parsePenaltyInput("-20,50")).toBeNull();
  });
});

function Editor() {
  const [value, setValue] = useState("");
  return <MoneyInput aria-label="Valor" value={value} onChange={(e) => setValue(e.target.value)} />;
}

describe("edição sem máscara durante digitação", () => {
  it("mantém campo, foco e centavos ao digitar, colar, apagar e sair", () => {
    render(<Editor />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    input.focus();
    for (const value of ["2", "20", "20,", "20,5", "20,50", "R$ 1.250,75", "1250,05", "", "20.50"]) {
      fireEvent.change(input, { target: { value } });
      expect(screen.getByRole("textbox")).toBe(input);
      expect(input).toHaveFocus();
      expect(input.value).toBe(value);
    }
    input.setSelectionRange(3, 5);
    fireEvent.change(input, { target: { value: "20.05" } });
    expect(parseMoneyInput(input.value)).toBe(20.05);
    fireEvent.blur(input);
    expect(input.value).toBe("20,05");
  });
  it("não mascara nem corrige silenciosamente entrada inválida", () => {
    render(<Editor />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "20,500" } });
    fireEvent.blur(input);
    expect(input).toHaveValue("20,500");
    expect(parseMoneyInput("20,500")).toBeNull();
  });
});