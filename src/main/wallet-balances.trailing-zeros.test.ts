// @vitest-environment node
// @lat: [[wallet-token-balances#Tests]]

import { describe, expect, it } from "vitest";
import { formatTokenBalance, formatTokenBalanceFull } from "../shared/tokens";

// Both formatters promise "up to 4 significant digits with trailing zeros
// removed", but they trimmed the fraction *before* capping it to 4 digits.
// When the cut lands on a zero that was only interior in the untrimmed
// fraction, that zero becomes trailing and was still rendered: 1.20001 HD
// showed as "1.2000", which reads as a balance pinned to 4 decimals rather
// than the exact 1.2 the digits round to.
describe("token balance trailing zeros after the 4-digit cut", () => {
  it("drops zeros the cut turns into trailing zeros", () => {
    // 1.20001 tokens → "1.2", not "1.2000"
    expect(formatTokenBalanceFull("1200010000000000000", 18)).toBe("1.2");
  });

  it("drops the whole fraction when the cut leaves only zeros", () => {
    // 1.00001 tokens → "1", not "1.0000"
    expect(formatTokenBalanceFull("1000010000000000000", 18)).toBe("1");
  });

  it("re-trims a sub-1 balance whose leading zeros are preserved", () => {
    // 0.0001200005 tokens → "0.00012": the three leading zeros stay, the
    // zeros exposed by the cut go.
    expect(formatTokenBalanceFull("120000500000000", 18)).toBe("0.00012");
  });

  it("applies to 6-decimal tokens", () => {
    // 1.20001 USDC-like → "1.2"
    expect(formatTokenBalanceFull("1200010", 6)).toBe("1.2");
  });

  it("re-trims through the compact formatter below the K threshold", () => {
    // 999.90001 tokens stays under 1,000, so the compact path falls through
    // to the full formatter and inherits the same cut.
    expect(formatTokenBalance("999900010000000000000", 18)).toBe("999.9");
  });

  it("keeps interior zeros that survive the cut (control)", () => {
    // 1.2001 tokens — all four digits are significant, so the trim must not
    // reach the interior zeros. Passes with and without the fix; it pins the
    // over-trimming regression the fix must not introduce.
    expect(formatTokenBalanceFull("1200100000000000000", 18)).toBe("1.2001");
  });

  it("keeps an interior zero while dropping the tail the cut exposes", () => {
    // 1.0200001 tokens → "1.02". The trim is anchored, so it must stop at the
    // "2" and leave the zero in front of it alone while still removing the
    // two zeros the cut turned into a tail. Was "1.0200".
    expect(formatTokenBalanceFull("1020000100000000000", 18)).toBe("1.02");
  });

  it("re-trims a sub-1 balance with no leading zeros", () => {
    // 0.100001 tokens → "0.1". firstNonZero is 0 here, so no leading zeros are
    // re-emitted and the cut's exposed tail is the whole visible fraction bar
    // the first digit. Was "0.1000".
    expect(formatTokenBalanceFull("100001000000000000", 18)).toBe("0.1");
  });

  it("re-trims a sub-1 balance for 6-decimal tokens", () => {
    // 0.100001 USDC-like → "0.1". The sub-1 branch is reached at a different
    // decimals scale than the 18-decimal cases above. Was "0.1000".
    expect(formatTokenBalanceFull("100001", 6)).toBe("0.1");
  });

  it("returns the bare integer when the fraction is past the 4-digit window", () => {
    // 1.000000001 tokens → "1". The "< 0.0001" early return only guards the
    // sub-1 branch, so here the cut yields four zeros, the re-trim empties
    // them, and the existing `capped ?` guard drops the point. Was "1.0000".
    expect(formatTokenBalanceFull("1000000001000000000", 18)).toBe("1");
  });

  it("leaves the compact K path untouched (control)", () => {
    // 1000.20001 tokens is at/above the K threshold, so formatTokenBalance
    // returns via compactScale and never reaches the changed lines. Passes
    // with and without the fix; it controls for the compact path, which the
    // control above does not cover.
    expect(formatTokenBalance("1000200010000000000000", 18)).toBe("1K");
  });
});
