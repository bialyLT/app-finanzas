import { describe, expect, it } from "vitest";
import {
  CSV_MAX_BYTES,
  CSV_MAX_ROWS,
  CsvError,
  parseCsv,
  parseCsvAmount,
  parseCsvDate,
  parseCsvKind,
  parseCsvRow,
} from "./csv";

const HEADER = "fecha,tipo,monto,cuenta";

function parseOne(csv: string) {
  const table = parseCsv(csv);
  return parseCsvRow(table.rows[0]);
}

describe("parseCsv · formato del archivo", () => {
  it("tolera BOM, CRLF y alias de encabezado", () => {
    const table = parseCsv(
      "\uFEFFFecha,Importe,Tipo,Cuenta\r\n2026-10-01,\"1.234,56\",Gasto,Efectivo\r\n",
    );

    expect(table.headers).toEqual(["Fecha", "Importe", "Tipo", "Cuenta"]);
    expect(table.rows).toHaveLength(1);

    const row = parseCsvRow(table.rows[0]);
    expect(row.date).toBe("2026-10-01");
    expect(row.amount).toBe("1234.56");
    expect(row.kind).toBe("EXPENSE");
    expect(row.accountName).toBe("Efectivo");
  });

  it("acepta encabezados con acentos, mayúsculas y espacios", () => {
    const table = parseCsv(
      "FECHA,Tipo,MONTO,Cuenta,Cuenta Destino,Categoría,Descripción\n2026-10-01,transferencia,10,Origen,Destino,,",
    );
    const row = parseCsvRow(table.rows[0]);
    expect(row.kind).toBe("TRANSFER");
    expect(row.toAccountName).toBe("Destino");
    expect(row.errors).toEqual([]);
  });

  it("parsea comas, comillas escapadas y saltos de línea dentro de comillas", () => {
    const table = parseCsv(
      `${HEADER},descripcion\n2026-10-01,gasto,10,Efectivo,"Súper, ""ofertas""\ny más"\n`,
    );
    const row = parseCsvRow(table.rows[0]);
    expect(row.description).toBe('Súper, "ofertas" y más');
    expect(row.errors).toEqual([]);
  });

  it("ignora líneas totalmente vacías pero cuenta las filas con comas", () => {
    const table = parseCsv(`${HEADER}\n\n2026-10-01,gasto,10,Efectivo\n,,,\n`);
    expect(table.rows).toHaveLength(2);
    expect(parseCsvRow(table.rows[1]).empty).toBe(true);
  });

  it("tolera líneas vacías antes del encabezado", () => {
    const table = parseCsv(`\n\n${HEADER}\n2026-10-01,gasto,10,Efectivo\n`);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].line).toBe(4);
  });

  it("rechaza un archivo sin encabezado", () => {
    expect(() => parseCsv("")).toThrow(CsvError);
    expect(() => parseCsv("\n\n")).toThrow(/vacío/);
  });

  it("rechaza columnas obligatorias faltantes", () => {
    expect(() => parseCsv("fecha,tipo,monto\n2026-10-01,gasto,10")).toThrow(
      /cuenta/,
    );
  });

  it("rechaza el mismo campo dos veces con alias distintos", () => {
    expect(() =>
      parseCsv("fecha,tipo,monto,monto,cuenta\n2026-10-01,gasto,10,20,Efectivo"),
    ).toThrow(/más de una columna/);
  });

  it("rechaza comillas sin cerrar y comillas mal ubicadas", () => {
    expect(() => parseCsv(`${HEADER}\n2026-10-01,gasto,10,"Efectivo`)).toThrow(
      /sin cerrar/,
    );
    expect(() => parseCsv(`${HEADER}\n2026-10-01,gasto,10,Efe"ctivo`)).toThrow(
      /comillas mal ubicadas/,
    );
  });

  it("rechaza bytes NUL", () => {
    expect(() => parseCsv(`${HEADER}\n2026-10-01,gasto,10,Efectivo\u0000`)).toThrow(
      /NUL/,
    );
  });

  it("rechaza un archivo que supera el máximo de bytes", () => {
    const padding = "x".repeat(CSV_MAX_BYTES);
    expect(() => parseCsv(`${HEADER}\n2026-10-01,gasto,10,${padding}`)).toThrow(
      /máximo/,
    );
  });

  it("rechaza más filas que el tope", () => {
    const rows = Array.from(
      { length: CSV_MAX_ROWS + 1 },
      (_, index) => `2026-10-${String((index % 28) + 1).padStart(2, "0")},gasto,10,Efectivo`,
    ).join("\n");
    expect(() => parseCsv(`${HEADER}\n${rows}`)).toThrow(/máximo/);
  });

  it("marca una fila con más columnas con datos como inválida", () => {
    const table = parseCsv(`${HEADER}\n2026-10-01,gasto,10,Efectivo,sobra`);
    const row = parseCsvRow(table.rows[0]);
    expect(row.errors.join(" ")).toMatch(/más columnas/);
  });

  it("acepta columnas desconocidas y las ignora", () => {
    const table = parseCsv(`${HEADER},id_externo\n2026-10-01,gasto,10,Efectivo,abc`);
    const row = parseCsvRow(table.rows[0]);
    expect(row.errors).toEqual([]);
  });
});

describe("parseCsvDate", () => {
  it("acepta ISO y DD/MM/YYYY", () => {
    expect(parseCsvDate("2026-10-01")).toEqual({ date: "2026-10-01", error: null });
    expect(parseCsvDate("01/10/2026")).toEqual({ date: "2026-10-01", error: null });
    expect(parseCsvDate("1/2/2026")).toEqual({ date: "2026-02-01", error: null });
  });

  it("rechaza fechas que no existen y formatos desconocidos", () => {
    expect(parseCsvDate("31/02/2026").date).toBeNull();
    expect(parseCsvDate("2026-02-31").date).toBeNull();
    expect(parseCsvDate("10-01-2026").error).toMatch(/no se entiende/);
    expect(parseCsvDate("").error).toMatch(/Falta/);
  });
});

describe("parseCsvKind", () => {
  it("acepta enums y nombres en castellano", () => {
    expect(parseCsvKind("INCOME")).toBe("INCOME");
    expect(parseCsvKind("Ingreso")).toBe("INCOME");
    expect(parseCsvKind("gasto")).toBe("EXPENSE");
    expect(parseCsvKind("Transferencia")).toBe("TRANSFER");
    expect(parseCsvKind("otro")).toBeNull();
  });
});

describe("parseCsvAmount", () => {
  it("interpreta formato argentino y punto decimal", () => {
    expect(parseCsvAmount("1.234,56").text).toBe("1234.56");
    expect(parseCsvAmount("1234.56").text).toBe("1234.56");
    expect(parseCsvAmount("1.234").text).toBe("1234.00");
    expect(parseCsvAmount("$ 1.500,00").text).toBe("1500.00");
  });

  it("rechaza cero, negativos, letras y más de dos decimales", () => {
    expect(parseCsvAmount("0").error).toMatch(/mayor a cero/);
    expect(parseCsvAmount("-10").error).toMatch(/positivo|mayor a cero/);
    expect(parseCsvAmount("1e5").error).toMatch(/no es un número/);
    expect(parseCsvAmount("10,999").error).toMatch(/dos decimales/);
  });

  it("rechaza montos que no entran en Decimal(18,2)", () => {
    expect(parseCsvAmount("99999999999999999").error).toMatch(/demasiado grande/);
  });
});

describe("parseCsvRow · forma por tipo", () => {
  it("acepta un gasto con categoría y descripción", () => {
    const row = parseOne(
      `${HEADER},categoria,descripcion\n2026-10-01,GASTO,"1.234,56",Efectivo,Comida,Súper`,
    );
    expect(row).toMatchObject({
      kind: "EXPENSE",
      date: "2026-10-01",
      amount: "1234.56",
      categoryName: "Comida",
      description: "Súper",
      errors: [],
    });
  });

  it("acepta un ingreso sin categoría", () => {
    const row = parseOne(`${HEADER}\n2026-10-01,ingreso,100,Banco`);
    expect(row.errors).toEqual([]);
    expect(row.categoryName).toBe("");
  });

  it("acepta una transferencia con destino distinto", () => {
    const row = parseOne(
      `${HEADER},cuenta_destino\n2026-10-01,transferencia,100,Origen,Destino`,
    );
    expect(row.errors).toEqual([]);
    expect(row.toAccountName).toBe("Destino");
  });

  it("rechaza transferencia sin destino, con el mismo destino o con categoría", () => {
    expect(
      parseOne(`${HEADER}\n2026-10-01,transferencia,100,Origen`).errors.join(" "),
    ).toMatch(/necesita cuenta_destino/);

    expect(
      parseOne(`${HEADER},cuenta_destino\n2026-10-01,transferencia,100,Origen,origen`)
        .errors.join(" "),
    ).toMatch(/distinta/);

    expect(
      parseOne(
        `${HEADER},cuenta_destino,categoria\n2026-10-01,transferencia,100,Origen,Destino,Comida`,
      ).errors.join(" "),
    ).toMatch(/no lleva categoría/);
  });

  it("rechaza destino en ingreso o gasto", () => {
    expect(
      parseOne(`${HEADER},cuenta_destino\n2026-10-01,gasto,100,Origen,Destino`).errors.join(
        " ",
      ),
    ).toMatch(/no lleva cuenta_destino/);
    expect(
      parseOne(`${HEADER},cuenta_destino\n2026-10-01,ingreso,100,Banco,Destino`).errors.join(
        " ",
      ),
    ).toMatch(/no lleva cuenta_destino/);
  });

  it("acumula varios errores de la misma fila", () => {
    const row = parseOne(`${HEADER}\n31/02/2026,otro,-5,,`);
    expect(row.errors.length).toBeGreaterThanOrEqual(3);
  });
});
