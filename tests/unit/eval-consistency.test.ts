import { describe, expect, it } from "vitest";
import { consistencyStats, mean } from "../../src/eval/consistency.js";

describe("consistencyStats", () => {
  it("is perfectly consistent when every run produced the same signature", () => {
    const s = consistencyStats({ "clockify_status()": 3 });
    expect(s.total).toBe(3);
    expect(s.distinct).toBe(1);
    expect(s.modal).toBe("clockify_status()");
    expect(s.modalFraction).toBe(1);
    expect(s.entropyBits).toBe(0);
    expect(s.normalizedEntropy).toBe(0);
  });

  it("is maximally inconsistent when every run produced a distinct signature", () => {
    const s = consistencyStats({ a: 1, b: 1, c: 1 });
    expect(s.total).toBe(3);
    expect(s.distinct).toBe(3);
    expect(s.modalFraction).toBeCloseTo(1 / 3, 6);
    expect(s.entropyBits).toBeCloseTo(Math.log2(3), 6); // ~1.585 bits
    expect(s.normalizedEntropy).toBeCloseTo(1, 6);
  });

  it("reports the modal signature and partial spread for a 2/1 split", () => {
    const s = consistencyStats({ "clockify_status()": 2, "clockify_start_timer()": 1 });
    expect(s.distinct).toBe(2);
    expect(s.modal).toBe("clockify_status()");
    expect(s.modalFraction).toBeCloseTo(2 / 3, 6);
    expect(s.entropyBits).toBeCloseTo(0.9183, 3);
    expect(s.normalizedEntropy).toBeCloseTo(0.9183 / Math.log2(3), 3); // ~0.579
  });

  it("treats a single run as consistent (no divide-by-zero on log2(1))", () => {
    const s = consistencyStats({ a: 1 });
    expect(s.total).toBe(1);
    expect(s.modalFraction).toBe(1);
    expect(s.normalizedEntropy).toBe(0);
    expect(s.entropyBits).toBe(0);
  });

  it("is safe on an empty histogram", () => {
    const s = consistencyStats({});
    expect(s.total).toBe(0);
    expect(s.distinct).toBe(0);
    expect(s.modal).toBe("");
    expect(s.modalFraction).toBe(0);
    expect(s.entropyBits).toBe(0);
    expect(s.normalizedEntropy).toBe(0);
  });

  it("picks the highest-count signature as modal regardless of insertion order", () => {
    const s = consistencyStats({ low: 1, high: 5, mid: 2 });
    expect(s.modal).toBe("high");
    expect(s.modalFraction).toBeCloseTo(5 / 8, 6);
  });
});

describe("mean", () => {
  it("averages a list", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([0.5, 1])).toBeCloseTo(0.75, 6);
  });

  it("is 0 for an empty list (no NaN)", () => {
    expect(mean([])).toBe(0);
  });
});
