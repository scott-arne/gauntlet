/**
 * Branded id types — make it a type error to transpose a runId for a
 * cardId at a call site. The brands live as zero-cost phantom types
 * (the underlying value is still a string at runtime).
 *
 * Boundary discipline: `asRunId`, `asCardId`, `asRunSetId` may appear
 * ONLY in the four genuine boundary classes:
 *   1. HTTP route handler param extraction
 *   2. Disk reads (`JSON.parse(readFileSync(...))` of result.json etc.)
 *   3. CLI args parsing (`src/cli/args.ts`)
 *   4. Id-constructor return values themselves (`makeRunId`, etc.)
 *
 * If the compiler is asking you to brand inside trusted internal code,
 * widen the producer or narrow the consumer — don't add an `as*` cast.
 */
declare const RunIdBrand: unique symbol;
export type RunId = string & { readonly [RunIdBrand]: true };

declare const CardIdBrand: unique symbol;
export type CardId = string & { readonly [CardIdBrand]: true };

declare const RunSetIdBrand: unique symbol;
export type RunSetId = string & { readonly [RunSetIdBrand]: true };

export const asRunId = (s: string): RunId => s as RunId;
export const asCardId = (s: string): CardId => s as CardId;
export const asRunSetId = (s: string): RunSetId => s as RunSetId;
