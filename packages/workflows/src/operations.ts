import Decimal from "decimal.js";
import { parseCsv, serializeCsv } from "./csv.js";
import { evaluatePredicate } from "./expressions.js";
import type { ExportedFile, JsonPrimitive, JsonValue, Row, WorkflowStep } from "./types.js";
import { MAX_WORKFLOW_ROWS } from "./types.js";

export function isRow(value: unknown): value is Row {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(
      (item) => item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean",
    )
  );
}

export function requireRows(value: JsonValue): Row[] {
  if (!Array.isArray(value) || value.length > MAX_WORKFLOW_ROWS || !value.every(isRow)) throw new Error("Operation requires a bounded row array.");
  return value;
}

export function filterRows(value: JsonValue, step: WorkflowStep): Row[] {
  if (!step.predicate) throw new Error("Filter predicate is missing.");
  return requireRows(value).filter((row) => evaluatePredicate(step.predicate as import("./types.js").PredicateExpression, row));
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalIsoDate(value: JsonPrimitive): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error("Date sorting requires canonical YYYY-MM-DD values and mode iso-date.");
  }
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) throw new Error("Date sorting received an invalid calendar date.");
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error("Date sorting received an invalid calendar date.");
  }
  return value;
}

function comparePrimitive(
  left: JsonPrimitive,
  right: JsonPrimitive,
  mode: "primitive" | "decimal" | "iso-date" = "primitive",
): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (mode === "decimal") {
    if ((typeof left !== "number" && typeof left !== "string") || (typeof right !== "number" && typeof right !== "string")) {
      throw new Error("Decimal sorting requires numeric values.");
    }
    const leftDecimal = new Decimal(left);
    const rightDecimal = new Decimal(right);
    if (!leftDecimal.isFinite() || !rightDecimal.isFinite()) throw new Error("Decimal sorting requires finite values.");
    return leftDecimal.comparedTo(rightDecimal);
  }
  if (mode === "iso-date") return compareCodePoints(canonicalIsoDate(left), canonicalIsoDate(right));
  if (typeof left !== typeof right) throw new Error("Sort values have incompatible types.");
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "string" && typeof right === "string") {
    if (/^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/u.test(left) || /^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/u.test(right)) {
      throw new Error("Date-like sort values require the explicit iso-date mode.");
    }
    return left.localeCompare(right, "en", { numeric: true });
  }
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  return 0;
}

export function sortRows(value: JsonValue, step: WorkflowStep): Row[] {
  const rows = requireRows(value).map((row, index) => ({ row, index }));
  const definitions = step.sort ?? [];
  rows.sort((left, right) => {
    for (const definition of definitions) {
      const result = comparePrimitive(left.row[definition.field] ?? null, right.row[definition.field] ?? null, definition.mode);
      if (result !== 0) return definition.direction === "asc" ? result : -result;
    }
    return left.index - right.index;
  });
  return rows.map(({ row }) => row);
}

export function projectRows(value: JsonValue, step: WorkflowStep): Row[] {
  const fields = step.fields ?? [];
  return requireRows(value).map((row) => {
    const projected = Object.create(null) as Row;
    for (const field of fields) projected[field] = row[field] ?? null;
    return projected;
  });
}

function numericValues(rows: readonly Row[], field: string): Decimal[] {
  return rows.map((row, index) => {
    const value = row[field];
    if (typeof value !== "number" && typeof value !== "string") throw new Error(`Aggregate field ${field} is not numeric at row ${index + 1}.`);
    const decimal = new Decimal(value);
    if (!decimal.isFinite()) throw new Error(`Aggregate field ${field} contains a non-finite value.`);
    return decimal;
  });
}

function exactDecimalResult(value: Decimal): string | number {
  if (!value.isFinite()) throw new Error("Aggregate produced a non-finite value.");
  if (value.isInteger() && value.abs().lessThanOrEqualTo(Number.MAX_SAFE_INTEGER)) return value.toNumber();
  return value.toString();
}

export function aggregateRows(value: JsonValue, step: WorkflowStep): Row {
  const rows = requireRows(value);
  const result = Object.create(null) as Row;
  for (const definition of step.aggregate ?? []) {
    if (definition.operation === "count") {
      result[definition.output] = rows.length;
      continue;
    }
    if (definition.currency) {
      const currencies = rows.map((row, index) => {
        const currency = row[definition.currency?.field as string];
        if (typeof currency !== "string" || !/^[A-Z]{3}$/u.test(currency)) {
          throw new Error(`Currency field ${definition.currency?.field as string} is invalid at row ${index + 1}.`);
        }
        return currency;
      });
      const distinct = [...new Set(currencies)];
      if (distinct.length > 1) throw new Error(`Aggregate ${definition.output} cannot combine mixed currencies.`);
      result[definition.currency.output] = distinct[0] ?? null;
    }
    const values = numericValues(rows, definition.field);
    if (values.length === 0) {
      result[definition.output] = null;
      continue;
    }
    let calculated: Decimal;
    switch (definition.operation) {
      case "sum":
        calculated = Decimal.sum(...values);
        break;
      case "min":
        calculated = Decimal.min(...values);
        break;
      case "max":
        calculated = Decimal.max(...values);
        break;
      case "average":
        calculated = Decimal.sum(...values).div(values.length);
        break;
    }
    result[definition.output] = exactDecimalResult(calculated);
  }
  return result;
}

export function compareRecords(value: JsonValue, fields: readonly string[] | undefined): JsonValue {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(isRow)) throw new Error("records.compare requires exactly two records.");
  const [left, right] = value;
  if (!left || !right) throw new Error("Comparison records are missing.");
  const names = fields ?? [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return names.map((field) => ({ field, left: left[field] ?? null, right: right[field] ?? null, equal: left[field] === right[field] }));
}

function sanitizeFilename(filename: string): string {
  const normalized = filename.normalize("NFKC").replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "_").replace(/[. ]+$/u, "");
  if (normalized.length < 1 || normalized.length > 128 || normalized === "." || normalized === "..") throw new Error("Export filename is invalid.");
  return normalized;
}

export function createExport(value: JsonValue, step: WorkflowStep): ExportedFile {
  const filename = sanitizeFilename(step.filename ?? "export.txt");
  switch (step.format) {
    case "csv": {
      const serialized = serializeCsv(requireRows(value));
      return { filename, mediaType: "text/csv", ...serialized };
    }
    case "json":
      return { filename, mediaType: "application/json", content: `${JSON.stringify(value, null, 2)}\n`, escapedFormulaCells: 0 };
    case "text":
      if (typeof value !== "string") throw new Error("Text export requires a string value.");
      return { filename, mediaType: "text/plain", content: value, escapedFormulaCells: 0 };
    default:
      throw new Error("Unsupported export format.");
  }
}

export function parseCsvOperation(value: JsonValue, maxRows: number): Row[] {
  if (typeof value !== "string") throw new Error("csv.parse requires text input.");
  return parseCsv(value, maxRows);
}
