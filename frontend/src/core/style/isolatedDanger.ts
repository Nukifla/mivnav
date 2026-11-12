// The S-52 isolated-danger predicate (ISODGR51 / UDWHAZ03), expressed ONCE so
// aidsHazards.ts's MapLibre expression and info/chartProvider.ts's plain-TS
// check can't drift apart. See docs/architecture/aids-hazards-style.md for
// the formula and the WRECKS QUASOU=7 gate.

import type { ExpressionSpecification as Expr } from "maplibre-gl";

/** The three S-57 classes the isolated-danger promotion applies to. WRECKS,
 * OBSTRN and UWTROC share the rule; only WRECKS adds the QUASOU=7 gate. */
export const HAZARD_CLASSES = ["WRECKS", "OBSTRN", "UWTROC"] as const;
export type HazardClass = (typeof HAZARD_CLASSES)[number];

const HAZARD_SET: ReadonlySet<string> = new Set(HAZARD_CLASSES);

export function isHazardClass(cls: string): cls is HazardClass {
  return HAZARD_SET.has(cls);
}

/** The primitive terms the predicate is built from; an interpreter (booleans
 * or MapLibre `Expr`) supplies each so the rule's *shape* lives in exactly
 * one function and both consumers inherit it. */
export interface DangerOps<T> {
  /** `props[attr]` is present (a number) and `<= ref`. */
  leq(attr: string, ref: number): T;
  /** `props[attr]` is present (a number) and `>= ref`. */
  geq(attr: string, ref: number): T;
  /** `props[attr]` is truthy. */
  truthy(attr: string): T;
  not(x: T): T;
  /** All terms hold. */
  all(terms: T[]): T;
}

/**
 * The predicate for one hazard class at one safety contour, built from `ops`.
 * OBSTRN and UWTROC produce the identical rule; WRECKS adds the QUASOU=7 gate.
 */
export function isolatedDanger<T>(ops: DangerOps<T>, cls: HazardClass, safety: number): T {
  const terms = [ops.leq("depth_value", safety), ops.geq("encl_drval1", safety)];
  if (cls === "WRECKS") terms.push(ops.not(ops.truthy("quasou7")));
  return ops.all(terms);
}

// ---- interpreter 1: plain TS, over a feature's decoded properties -----------

type Props = Readonly<Record<string, unknown>>;

/** Present-and-numeric, matching the style: MapLibre's `<=`/`>=` over a missing
 * `get` does not match, so an absent depth reads as "not a danger" here too. */
function propsOps(props: Props): DangerOps<boolean> {
  const cmp = (attr: string, ok: (v: number) => boolean): boolean => {
    const v = props[attr];
    return typeof v === "number" && ok(v);
  };
  return {
    leq: (attr, ref) => cmp(attr, (v) => v <= ref),
    geq: (attr, ref) => cmp(attr, (v) => v >= ref),
    truthy: (attr) => Boolean(props[attr]),
    not: (x) => !x,
    all: (terms) => terms.every(Boolean),
  };
}

/**
 * Evaluate the predicate on a tapped feature. `cls` that is not a hazard class
 * is never a danger — the caller need not pre-filter.
 */
export function isIsolatedDangerProps(cls: string, props: Props, safety: number): boolean {
  if (!isHazardClass(cls)) return false;
  return isolatedDanger(propsOps(props), cls, safety);
}

// ---- interpreter 2: a MapLibre expression -----------------------------------

/** Each comparison guards its attribute with `has`, so a missing attribute is
 * `false` not a type error — matching the TS interpreter. */
const exprOps: DangerOps<Expr> = {
  leq: (attr, ref) => ["all", ["has", attr], ["<=", ["get", attr], ref]],
  geq: (attr, ref) => ["all", ["has", attr], [">=", ["get", attr], ref]],
  truthy: (attr) => ["to-boolean", ["get", attr]],
  not: (x) => ["!", x],
  all: (terms) => ["all", ...terms],
};

/** The MapLibre expression form of the predicate, for the style. */
export function isolatedDangerExpr(cls: HazardClass, safety: number): Expr {
  return isolatedDanger(exprOps, cls, safety);
}
