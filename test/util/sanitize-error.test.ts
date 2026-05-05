import { describe, test, expect } from "bun:test";
import { inspect } from "util";
import { sanitizeLlmError, LlmError, withLlmErrorSanitization } from "../../src/util/sanitize-error";

// Mimic the shape of @anthropic-ai/sdk's APIError without dragging the SDK
// constructor in — we only care that sanitizeLlmError reads from `status`,
// `headers`, `requestID`, `error.error.type`, and the Error `message`.
function fakeAnthropicApiError(opts: {
  status: number;
  message: string;
  headerEntries?: Array<[string, string]>;
  requestID?: string;
  bodyType?: string;
  bodyMessage?: string;
}): Error {
  const headers = new Headers(opts.headerEntries ?? []);
  const body =
    opts.bodyType !== undefined
      ? { type: "error", error: { type: opts.bodyType, message: opts.bodyMessage ?? "" } }
      : undefined;
  return Object.assign(new Error(opts.message), {
    status: opts.status,
    headers,
    requestID: opts.requestID,
    error: body,
    name: "APIError",
  });
}

describe("sanitizeLlmError", () => {
  test("extracts allow-listed fields from a synthetic Anthropic APIError", () => {
    const err = fakeAnthropicApiError({
      status: 429,
      message: "429 too fast",
      headerEntries: [
        ["anthropic-organization-id", "00000000-1111-2222-3333-444444444444"],
        ["cf-ray", "abcdef-DFW"],
        ["traceresponse", "00-aaaa-bbbb-01"],
        ["set-cookie", "session=secret-secret; Path=/"],
        ["request-id", "req_xyz"],
      ],
      requestID: "req_xyz",
      bodyType: "rate_limit_error",
      bodyMessage: "too fast",
    });

    const sanitized = sanitizeLlmError(err);

    expect(sanitized).toBeInstanceOf(LlmError);
    expect(sanitized.status).toBe(429);
    expect(sanitized.requestId).toBe("req_xyz");
    expect(sanitized.errorType).toBe("rate_limit_error");
    expect(sanitized.message).toBe("429 too fast");
  });

  test("does not leak header values via any reachable property", () => {
    const err = fakeAnthropicApiError({
      status: 401,
      message: "401 invalid x-api-key",
      headerEntries: [
        ["anthropic-organization-id", "ORG-LEAK-UUID"],
        ["cf-ray", "CFRAY-LEAK"],
        ["set-cookie", "SESSION-LEAK"],
      ],
      requestID: "req_a",
      bodyType: "authentication_error",
      bodyMessage: "invalid x-api-key",
    });

    const sanitized = sanitizeLlmError(err);

    // Serialize every own property — including non-enumerable — and confirm
    // no header value is reachable.
    const allProps = Object.getOwnPropertyNames(sanitized);
    const serialized = JSON.stringify(sanitized, allProps);
    expect(serialized).not.toContain("ORG-LEAK-UUID");
    expect(serialized).not.toContain("CFRAY-LEAK");
    expect(serialized).not.toContain("SESSION-LEAK");

    // Bun/Node inspectors also walk .cause; sanitizer must not attach the
    // original error there.
    expect((sanitized as Error & { cause?: unknown }).cause).toBeUndefined();

    // util.inspect is what Bun's unhandled-rejection printer ultimately
    // calls. Confirm it produces clean output.
    const inspected = inspect(sanitized, { depth: null });
    expect(inspected).not.toContain("ORG-LEAK-UUID");
    expect(inspected).not.toContain("CFRAY-LEAK");
    expect(inspected).not.toContain("SESSION-LEAK");
  });

  test("passes plain Error through with message preserved", () => {
    const sanitized = sanitizeLlmError(new Error("boom"));
    expect(sanitized).toBeInstanceOf(LlmError);
    expect(sanitized.message).toBe("boom");
    expect(sanitized.status).toBeUndefined();
    expect(sanitized.requestId).toBeUndefined();
    expect(sanitized.errorType).toBeUndefined();
  });

  test("wraps non-Error thrown values safely", () => {
    const sanitized = sanitizeLlmError("string thrown");
    expect(sanitized).toBeInstanceOf(LlmError);
    expect(sanitized.message).toBe("string thrown");
  });

  test("withLlmErrorSanitization rethrows LlmError when fn throws APIError-shaped value", async () => {
    const err = Object.assign(new Error("500 boom"), {
      status: 500,
      headers: new Headers([["set-cookie", "LEAK"]]),
      requestID: "req_z",
    });

    let caught: unknown;
    try {
      await withLlmErrorSanitization(async () => {
        throw err;
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(LlmError);
    expect((caught as LlmError).status).toBe(500);
    expect((caught as LlmError).requestId).toBe("req_z");
    expect((caught as LlmError).message).toBe("500 boom");
    // Ensure the original error is not reachable via .cause.
    expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  test("withLlmErrorSanitization passes return value through on success", async () => {
    const out = await withLlmErrorSanitization(async () => 42);
    expect(out).toBe(42);
  });

  test("handles APIConnectionError shape (no status, no headers)", () => {
    const err = Object.assign(new Error("Connection error."), {
      status: undefined,
      headers: undefined,
      requestID: undefined,
      name: "APIConnectionError",
    });
    const sanitized = sanitizeLlmError(err);
    expect(sanitized).toBeInstanceOf(LlmError);
    expect(sanitized.message).toBe("Connection error.");
    expect(sanitized.status).toBeUndefined();
  });
});
