import Decimal from "decimal.js";
import type { JsonPrimitive, PredicateExpression, Row, ValueExpression } from "./types.js";

function decimal(value: JsonPrimitive): Decimal {
  if (typeof value !== "number" && typeof value !== "string") throw new Error("Arithmetic requires explicit numeric values.");
  const result = new Decimal(value);
  if (!result.isFinite()) throw new Error("Arithmetic produced a non-finite value.");
  return result;
}

export function evaluateValue(expression: ValueExpression, row: Row): JsonPrimitive {
  if ("literal" in expression) return expression.literal;
  if ("field" in expression) return row[expression.field] ?? null;
  const left = decimal(evaluateValue(expression.left, row));
  const right = decimal(evaluateValue(expression.right, row));
  switch (expression.op) {
    case "add":
      return left.add(right).toNumber();
    case "subtract":
      return left.sub(right).toNumber();
    case "multiply":
      return left.mul(right).toNumber();
    case "divide":
      if (right.isZero()) throw new Error("Division by zero.");
      return left.div(right).toNumber();
  }
}

function compare(left: JsonPrimitive, right: JsonPrimitive): number {
  if (left === null || right === null) return left === right ? 0 : left === null ? -1 : 1;
  if (typeof left !== typeof right) throw new Error("Comparison operands have different types.");
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "string" && typeof right === "string") return left.localeCompare(right, "en", { numeric: true });
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  return 0;
}

export function evaluatePredicate(expression: PredicateExpression, row: Row): boolean {
  if (expression.op === "and") return expression.operands.every((operand) => evaluatePredicate(operand, row));
  if (expression.op === "or") return expression.operands.some((operand) => evaluatePredicate(operand, row));
  if (expression.op === "not") return !evaluatePredicate(expression.operand, row);
  if (!("left" in expression) || !("right" in expression)) throw new Error("Comparison operands are missing.");
  const result = compare(evaluateValue(expression.left, row), evaluateValue(expression.right, row));
  switch (expression.op) {
    case "eq":
      return result === 0;
    case "neq":
      return result !== 0;
    case "gt":
      return result > 0;
    case "gte":
      return result >= 0;
    case "lt":
      return result < 0;
    case "lte":
      return result <= 0;
  }
}
