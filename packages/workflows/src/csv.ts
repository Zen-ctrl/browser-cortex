import type { JsonPrimitive, Row } from "./types.js";
import { MAX_WORKFLOW_ROWS } from "./types.js";
import { assertSafeKey } from "./canonical.js";

const MAX_CSV_INPUT_BYTES = 20 * 1024 * 1024;

export function parseCsv(input: string, maxRows = MAX_WORKFLOW_ROWS, maxBytes = MAX_CSV_INPUT_BYTES): Row[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("CSV byte limit is invalid.");
  const boundedMaxBytes = Math.min(maxBytes, MAX_CSV_INPUT_BYTES);
  if (new TextEncoder().encode(input).byteLength > boundedMaxBytes) throw new Error("CSV input exceeds the byte limit.");
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field.length === 0) quoted = true;
    else if (character === ",") {
      record.push(field);
      field = "";
    } else if (character === "\n") {
      record.push(field.replace(/\r$/u, ""));
      records.push(record);
      if (records.length > maxRows + 1) throw new Error("CSV exceeds the workflow row limit.");
      record = [];
      field = "";
    } else field += character;
  }
  if (quoted) throw new Error("CSV has an unterminated quoted field.");
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
    if (records.length > maxRows + 1) throw new Error("CSV exceeds the workflow row limit.");
  }
  const headers = records.shift();
  if (!headers || headers.length === 0 || headers.every((header) => header.trim() === "")) return [];
  const normalized = headers.map((header) => header.trim());
  for (const header of normalized) {
    if (!header) throw new Error("CSV header names cannot be empty.");
    assertSafeKey(header);
  }
  if (new Set(normalized).size !== normalized.length) throw new Error("CSV header names must be unique.");
  return records.filter((values) => values.some((value) => value.length > 0)).map((values, rowIndex) => {
    if (values.length !== normalized.length) throw new Error(`CSV row ${rowIndex + 2} has an unexpected column count.`);
    const row = Object.create(null) as Row;
    for (let index = 0; index < normalized.length; index += 1) row[normalized[index] as string] = values[index] ?? "";
    return row;
  });
}

function escapeCsv(value: JsonPrimitive): { value: string; formulaEscaped: boolean } {
  let rendered = value === null ? "" : String(value);
  let formulaEscaped = false;
  if (/^(?:[\t\r]|\s*[=+@-])/u.test(rendered)) {
    rendered = `'${rendered}`;
    formulaEscaped = true;
  }
  if (/[",\r\n]/u.test(rendered)) rendered = `"${rendered.replace(/"/gu, '""')}"`;
  return { value: rendered, formulaEscaped };
}

export function serializeCsv(rows: readonly Row[]): { content: string; escapedFormulaCells: number } {
  if (rows.length > MAX_WORKFLOW_ROWS) throw new Error("Rows exceed the workflow export limit.");
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort((left, right) => left.localeCompare(right));
  for (const header of headers) assertSafeKey(header);
  let escapedFormulaCells = 0;
  const lines = [headers.map((header) => escapeCsv(header).value).join(",")];
  for (const row of rows) {
    lines.push(
      headers
        .map((header) => {
          const escaped = escapeCsv(row[header] ?? null);
          if (escaped.formulaEscaped) escapedFormulaCells += 1;
          return escaped.value;
        })
        .join(","),
    );
  }
  return { content: `${lines.join("\r\n")}\r\n`, escapedFormulaCells };
}
