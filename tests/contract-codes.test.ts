import { test, expect } from "bun:test";
import { statusForCode } from "../src/contract.ts";

// Regression: DISCARD_FAILED / STAGE_FAILED / DELETE_FAILED were declared in the ApiErrorCode
// union but omitted from STATUS_BY_CODE, so statusForCode fell through to the `?? 500` default
// and every failed discard/stage/delete answered 500 — mislabelling an owner-actionable failure
// as a daemon fault, unlike the sibling repo-state codes which answer 409.
test("failed discard/stage/delete map to 409, not the 500 fallback", () => {
  expect(statusForCode("DISCARD_FAILED")).toBe(409);
  expect(statusForCode("STAGE_FAILED")).toBe(409);
  expect(statusForCode("DELETE_FAILED")).toBe(409);
});
