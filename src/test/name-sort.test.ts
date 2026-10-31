import { describe, expect, it } from "vitest";
import { compareNamesPtBr } from "@/lib/name-sort";

describe("compareNamesPtBr", () => {
  it("ordena alfabeticamente ignorando acentos e maiúsculas", () => {
    const sorted = ["Carlos", "érica", "Bruno", "Ana", "Ágata"].sort(compareNamesPtBr);
    expect(sorted).toEqual(["Ágata", "Ana", "Bruno", "Carlos", "érica"]);
  });

  it("trata acento como igualdade na ordenação principal e usa desempate estável", () => {
    expect(compareNamesPtBr("Ágata", "Ana")).toBeLessThan(0);
    expect(compareNamesPtBr("Bruno", "Érica")).toBeLessThan(0);
    expect(compareNamesPtBr("éRICA", "Erica")).toBe(-compareNamesPtBr("Erica", "éRICA"));
    // desempate é determinístico: qualquer ordem de entrada produz o mesmo resultado
    expect(["Erica", "éRICA"].sort(compareNamesPtBr)).toEqual(["Erica", "éRICA"]);
    expect(["éRICA", "Erica"].sort(compareNamesPtBr)).toEqual(["Erica", "éRICA"]);
  });

  it("aceita valores ausentes sem quebrar", () => {
    expect(compareNamesPtBr(null, "Ana")).toBeLessThan(0);
    expect(compareNamesPtBr("Ana", undefined)).toBeGreaterThan(0);
  });
});
