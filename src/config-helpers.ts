/**
 * Config-parser combinator. Replaces the ~15 hand-rolled
 * `let value; let source: ... ; if (env) ... ; if (arg) ...` blocks in
 * `config.ts` with a single declarative helper. The plan is documented in
 * docs/superpowers/plans/2026-05-18-pri-1628-cleanup-sweep.md (Phase 4).
 *
 * The `noValueSource` generic parameter handles the three source-union
 * shapes that exist in `AppConfig.sources` today:
 *   - `"default" | "env" | "flag"` (most knobs)
 *   - `"default" | "env"` (env-only operator knobs — use the
 *     `resolveEnvOnlySetting` sibling for an exact return type)
 *   - `"default" | "env" | "flag" | "unset"` — `defaultTarget`,
 *     `models.fanout` start as "unset" because there is no in-code default
 */

export type SettingSource = "default" | "env" | "flag";

export interface SettingSpec<T, NoVal extends string = "default"> {
  default: T;
  /**
   * Source string used when neither env nor arg provided a value.
   * Defaults to "default"; pass "unset" for knobs that have no in-code
   * default (defaultTarget, models.fanout).
   */
  noValueSource?: NoVal;
  /**
   * Environment-variable surface. `parse` converts the raw string to `T`
   * or throws. An empty-string env var is treated as unset (matches the
   * pre-refactor `if (env.X)` truthy-check semantics).
   */
  env?: { name: string; parse: (raw: string) => T };
  /**
   * CLI-argument surface. `undefined` means "no flag supplied"; any other
   * value wins (flags trump env trump default).
   */
  arg?: { value: T | undefined };
}

export interface Resolved<T, NoVal extends string = "default"> {
  value: T;
  source: NoVal | "env" | "flag";
}

export function resolveSetting<T, NoVal extends string = "default">(
  spec: SettingSpec<T, NoVal>,
  envBag: NodeJS.ProcessEnv,
): Resolved<T, NoVal> {
  let value = spec.default;
  let source: NoVal | "env" | "flag" = (spec.noValueSource ?? ("default" as NoVal));
  if (spec.env) {
    const raw = envBag[spec.env.name];
    if (raw !== undefined && raw !== "") {
      value = spec.env.parse(raw);
      source = "env";
    }
  }
  if (spec.arg && spec.arg.value !== undefined) {
    value = spec.arg.value;
    source = "flag";
  }
  return { value, source };
}

/**
 * Exact-narrowed sibling for env-only operator knobs. Identical machinery,
 * but the return type is `"default" | "env"` instead of including a
 * never-reachable `"flag"` arm.
 */
export interface EnvOnlySpec<T> {
  default: T;
  env: { name: string; parse: (raw: string) => T };
}

export interface ResolvedEnvOnly<T> {
  value: T;
  source: "default" | "env";
}

export function resolveEnvOnlySetting<T>(
  spec: EnvOnlySpec<T>,
  envBag: NodeJS.ProcessEnv,
): ResolvedEnvOnly<T> {
  const raw = envBag[spec.env.name];
  if (raw !== undefined && raw !== "") {
    return { value: spec.env.parse(raw), source: "env" };
  }
  return { value: spec.default, source: "default" };
}
