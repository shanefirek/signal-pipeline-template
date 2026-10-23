import { describe, it, expect } from "vitest";
import { toHubSpotDate } from "../lib/hubspot.js";

describe("toHubSpotDate", () => {
  it("converts ISO timestamp with time to midnight UTC epoch ms", () => {
    // 2026-04-20T21:09:56.193Z → midnight Apr 20 UTC = 1745107200000
    const result = toHubSpotDate("2026-04-20T21:09:56.193Z");
    expect(result).toBe(String(Date.UTC(2026, 3, 20)));
  });

  it("converts ISO date-only string to midnight UTC epoch ms", () => {
    const result = toHubSpotDate("2026-04-20");
    expect(result).toBe(String(Date.UTC(2026, 3, 20)));
  });

  it("converts ISO with timezone offset to midnight UTC epoch ms", () => {
    // 2026-04-20T17:08:40.976+00:00 → midnight Apr 20 UTC
    const result = toHubSpotDate("2026-04-20T17:08:40.976+00:00");
    expect(result).toBe(String(Date.UTC(2026, 3, 20)));
  });

  it("returns undefined for undefined input", () => {
    expect(toHubSpotDate(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(toHubSpotDate("")).toBeUndefined();
  });

  it("returns undefined for invalid date string", () => {
    expect(toHubSpotDate("not-a-date")).toBeUndefined();
  });

  it("already-midnight timestamp stays correct", () => {
    const result = toHubSpotDate("2026-04-20T00:00:00.000Z");
    expect(result).toBe(String(Date.UTC(2026, 3, 20)));
  });
});
