import { describe, it, expect } from "bun:test";
import { resolveSetting, resolveEnvOnlySetting } from "../../src/config-helpers";

describe("resolveSetting", () => {
  it("returns default when neither env nor arg present", () => {
    const r = resolveSetting({ default: 42 }, {});
    expect(r).toEqual({ value: 42, source: "default" });
  });

  it("returns env when set", () => {
    const r = resolveSetting({
      default: 42,
      env: { name: "FOO", parse: (s) => parseInt(s, 10) },
    }, { FOO: "7" });
    expect(r).toEqual({ value: 7, source: "env" });
  });

  it("returns arg when provided (overrides env)", () => {
    const r = resolveSetting({
      default: 42,
      env: { name: "FOO", parse: (s) => parseInt(s, 10) },
      arg: { value: 9 },
    }, { FOO: "7" });
    expect(r).toEqual({ value: 9, source: "flag" });
  });

  it("ignores empty-string env (treats as unset)", () => {
    const r = resolveSetting({
      default: 42,
      env: { name: "FOO", parse: (s) => parseInt(s, 10) },
    }, { FOO: "" });
    expect(r).toEqual({ value: 42, source: "default" });
  });

  it("noValueSource lets caller widen the source union to 'unset'", () => {
    // For knobs like defaultTarget where there is no in-code default
    // the source starts as "unset" rather than "default".
    const r = resolveSetting<string | undefined, "unset">({
      default: undefined,
      noValueSource: "unset",
      env: { name: "FOO", parse: (s) => s },
    }, {});
    expect(r).toEqual({ value: undefined, source: "unset" });
  });
});

describe("resolveEnvOnlySetting", () => {
  it("returns default when env not set", () => {
    const r = resolveEnvOnlySetting({
      default: 100,
      env: { name: "FOO", parse: (s) => parseInt(s, 10) },
    }, {});
    expect(r).toEqual({ value: 100, source: "default" });
  });

  it("returns env when set", () => {
    const r = resolveEnvOnlySetting({
      default: 100,
      env: { name: "FOO", parse: (s) => parseInt(s, 10) },
    }, { FOO: "55" });
    expect(r).toEqual({ value: 55, source: "env" });
  });

  it("ignores empty-string env (treats as unset)", () => {
    const r = resolveEnvOnlySetting({
      default: 100,
      env: { name: "FOO", parse: (s) => parseInt(s, 10) },
    }, { FOO: "" });
    expect(r).toEqual({ value: 100, source: "default" });
  });
});
