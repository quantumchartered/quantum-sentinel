import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CURRENCY_EXPONENTS,
  type Currency,
  MoneyError,
  add,
  compare,
  fromMoneyJson,
  majorToMinor,
  minorToMajor,
  money,
  subtract,
  toMoneyJson,
} from "./money.js";

const currencies = Object.keys(CURRENCY_EXPONENTS) as Currency[];
const currencyArb = fc.constantFrom(...currencies);

describe("majorToMinor", () => {
  it.each([
    ["100.50", "USD", 10050n],
    ["100.5", "USD", 10050n],
    ["100", "USD", 10000n],
    ["0.01", "USD", 1n],
    ["25000", "USD", 2500000n],
    ["1000", "JPY", 1000n],
    ["1000.00", "JPY", 1000n],
    ["-12.85", "EUR", -1285n],
  ] as const)("%s %s -> %s", (major, currency, expected) => {
    expect(majorToMinor(major, currency)).toBe(expected);
  });

  it("accepts JSON numbers as Airwallex returns them", () => {
    expect(majorToMinor(68.13, "SGD")).toBe(6813n);
    expect(majorToMinor(50.0, "USD")).toBe(5000n);
  });

  it.each(["1e3", "12.345", "1,000", "", "abc", " . ", "0x10", "1.2.3", "+5"])(
    "rejects %j",
    (bad) => {
      expect(() => majorToMinor(bad, "USD")).toThrow(MoneyError);
    },
  );

  it("rejects fractional JPY", () => {
    expect(() => majorToMinor("10.5", "JPY")).toThrow(MoneyError);
  });

  it("rejects float artefacts instead of rounding them", () => {
    expect(() => majorToMinor(0.1 + 0.2, "USD")).toThrow(MoneyError);
    expect(() => majorToMinor(Number.NaN, "USD")).toThrow(MoneyError);
    expect(() => majorToMinor(Infinity, "USD")).toThrow(MoneyError);
    expect(() => majorToMinor(1e21, "USD")).toThrow(MoneyError);
  });

  it("refuses numeric amounts too large to be exact", () => {
    expect(() => majorToMinor(1e13, "USD")).toThrow(/too large/);
    // the same value as a string is fine
    expect(majorToMinor("10000000000000", "USD")).toBe(1000000000000000n);
  });
});

describe("minorToMajor", () => {
  it.each([
    [10050n, "USD", "100.50"],
    [1n, "USD", "0.01"],
    [0n, "USD", "0.00"],
    [-1285n, "EUR", "-12.85"],
    [1000n, "JPY", "1000"],
  ] as const)("%s %s -> %s", (minor, currency, expected) => {
    expect(minorToMajor(minor, currency)).toBe(expected);
  });
});

describe("properties", () => {
  it("string round trip is exact for any bigint", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }), currencyArb, (minor, c) => {
        expect(majorToMinor(minorToMajor(minor, c), c)).toBe(minor);
      }),
    );
  });

  it("JSON-number path agrees with the exact value below the safe bound", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e14 + 1, max: 1e14 - 1 }), (cents) => {
        const asNumber = cents / 100; // what JSON.parse would hand us
        expect(majorToMinor(asNumber, "USD")).toBe(BigInt(cents));
      }),
    );
  });

  it("add/subtract are inverse and preserve currency", () => {
    fc.assert(
      fc.property(fc.bigInt(), fc.bigInt(), currencyArb, (a, b, c) => {
        const sum = add(money(a, c), money(b, c));
        expect(subtract(sum, money(b, c))).toEqual(money(a, c));
        expect(compare(sum, money(a, c))).toBe(b > 0n ? 1 : b < 0n ? -1 : 0);
      }),
    );
  });

  it("never mixes currencies", () => {
    expect(() => add(money(1n, "USD"), money(1n, "EUR"))).toThrow(MoneyError);
  });

  it("JSON form round trips", () => {
    fc.assert(
      fc.property(fc.bigInt(), currencyArb, (a, c) => {
        expect(fromMoneyJson(JSON.parse(JSON.stringify(toMoneyJson(money(a, c)))))).toEqual(
          money(a, c),
        );
      }),
    );
  });
});
