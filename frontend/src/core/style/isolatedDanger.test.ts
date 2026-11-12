import { describe, expect, test } from "bun:test";
import type { ExpressionSpecification as Expr } from "maplibre-gl";
import {
  HAZARD_CLASSES,
  isIsolatedDangerProps,
  isolatedDangerExpr,
  type HazardClass,
} from "./isolatedDanger";

// The predicate lives once and is consumed two ways — plain TS in the info
// panel, a MapLibre expression in the style. The point of the shared definition
// is that the two can NEVER disagree, so the load-bearing test evaluates both
// forms over the same inputs and asserts they always give the same answer.

/** A minimal evaluator for exactly the expression nodes isolatedDangerExpr
 * emits (`all`, `has`, `get`, `<=`, `>=`, `to-boolean`, `!`). It stands in for
 * MapLibre's own — small enough to trust, and its whole job is to reproduce
 * MapLibre's "missing get is absent, comparison over it is false" semantics so
 * the cross-check is honest. Anything unexpected throws, so a changed shape
 * fails loudly rather than passing vacuously. */
function evalExpr(node: Expr | number | string | boolean, props: Record<string, unknown>): unknown {
  if (!Array.isArray(node)) return node;
  const [op, ...args] = node;
  switch (op) {
    case "get":
      return props[args[0] as string];
    case "has":
      return (args[0] as string) in props;
    case "all":
      return args.every((a) => evalExpr(a as Expr, props) === true);
    case "!":
      return !(evalExpr(args[0] as Expr, props) === true);
    case "to-boolean":
      return Boolean(evalExpr(args[0] as Expr, props));
    case "<=":
    case ">=": {
      const l = evalExpr(args[0] as Expr, props);
      const r = evalExpr(args[1] as Expr, props);
      if (typeof l !== "number" || typeof r !== "number") {
        throw new Error(`comparison over non-number (${op}): the guard should have caught this`);
      }
      return op === "<=" ? l <= r : l >= r;
    }
    default:
      throw new Error(`unexpected expression node: ${op}`);
  }
}

const SAFETY = 5;

// A grid of feature shapes covering every branch: below/at/above the contour,
// present/absent facts, and the WRECKS quasou7 gate.
const CASES: Record<string, unknown>[] = [
  {},
  { depth_value: 3 },
  { encl_drval1: 10 },
  { depth_value: 3, encl_drval1: 10 }, // the danger
  { depth_value: 5, encl_drval1: 5 }, // both exactly at the contour
  { depth_value: 6, encl_drval1: 10 }, // too deep to be a danger
  { depth_value: 3, encl_drval1: 4 }, // not in deeper water
  { depth_value: 3, encl_drval1: 10, quasou7: true }, // WRECKS gate
  { depth_value: 3, encl_drval1: 10, quasou7: false },
];

describe("isolatedDanger: the two interpreters never disagree", () => {
  for (const cls of HAZARD_CLASSES) {
    const expr = isolatedDangerExpr(cls, SAFETY);
    for (const props of CASES) {
      test(`${cls} ${JSON.stringify(props)} — expr == props form`, () => {
        const viaProps = isIsolatedDangerProps(cls, props, SAFETY);
        const viaExpr = evalExpr(expr, props) === true;
        expect(viaExpr).toBe(viaProps);
      });
    }
  }
});

describe("isolatedDanger: the rule", () => {
  const danger = { depth_value: 3, encl_drval1: 10 };

  test("shallow hazard in deeper water is a danger", () => {
    for (const cls of HAZARD_CLASSES) {
      expect(isIsolatedDangerProps(cls, danger, SAFETY)).toBe(true);
    }
  });

  test("both bounds are inclusive at the contour", () => {
    expect(isIsolatedDangerProps("OBSTRN", { depth_value: 5, encl_drval1: 5 }, SAFETY)).toBe(true);
  });

  test("no surrounding depth area — not promoted", () => {
    expect(isIsolatedDangerProps("OBSTRN", { depth_value: 3 }, SAFETY)).toBe(false);
  });

  test("WRECKS QUASOU=7 blocks the promotion; OBSTRN/UWTROC have no such gate", () => {
    const props = { ...danger, quasou7: true };
    expect(isIsolatedDangerProps("WRECKS", props, SAFETY)).toBe(false);
    expect(isIsolatedDangerProps("OBSTRN", props, SAFETY)).toBe(true);
    expect(isIsolatedDangerProps("UWTROC", props, SAFETY)).toBe(true);
  });

  test("non-hazard classes are never promoted", () => {
    expect(isIsolatedDangerProps("DEPARE", danger, SAFETY)).toBe(false);
    expect(isIsolatedDangerProps("SOUNDG", danger, SAFETY)).toBe(false);
  });

  test("only WRECKS carries the quasou7 term in its expression", () => {
    const s = (cls: HazardClass) => JSON.stringify(isolatedDangerExpr(cls, SAFETY));
    expect(s("WRECKS")).toContain("quasou7");
    expect(s("OBSTRN")).not.toContain("quasou7");
    expect(s("OBSTRN")).toBe(s("UWTROC"));
  });
});
