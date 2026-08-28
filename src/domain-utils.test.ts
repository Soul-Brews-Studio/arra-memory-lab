import { describe, expect, test } from "bun:test";
import {
  limitFor,
  optionalText,
  projectText,
  provenanceTags,
  queryTerms,
  required
} from "./domain-utils";

describe("domain utility contracts", () => {
  test("keeps a Thai word whole instead of splitting on its combining marks", () => {
    // Thai vowels/tone marks are combining code points. Without \p{M} in the
    // character class these act as separators: ["บ","นท","ก"].
    expect(queryTerms("บันทึก")).toEqual(["บันทึก"]);
    expect(queryTerms("ที่คั่นหน้า")).toEqual(["ที่คั่นหน้า"]);
  });

  test("a shredded Thai query no longer matches unrelated text", () => {
    // The old split left single-character fragments that substring-match any
    // Thai text, scoring irrelevant memories as hits.
    const unrelated = "กรุงเทพมหานคร เป็นเมืองหลวง";
    expect(queryTerms("บันทึก").some((term) => unrelated.includes(term))).toBe(false);
  });

  test("still splits on whitespace and punctuation", () => {
    expect(queryTerms("Oracle, memory")).toEqual(["oracle", "memory"]);
    expect(queryTerms("ความจำ oracle")).toEqual(["ความจำ", "oracle"]);
  });

  test("canonicalizes repository scope once", () => {
    expect(projectText("https://GitHub.com/Soul-Brews-Studio/Repo///"))
      .toBe("github.com/soul-brews-studio/repo");
    expect(projectText("   ")).toBeNull();
  });

  test("keeps one normalized Oracle discovery tag", () => {
    expect(provenanceTags(["OAuth", "oracle-old", "oauth"], "Neo"))
      .toEqual(["oracle-neo", "oauth"]);
  });

  test("bounds list limits without leaking fractional values", () => {
    expect(limitFor(undefined)).toBe(10);
    expect(limitFor(-3)).toBe(1);
    expect(limitFor(12.9)).toBe(12);
    expect(limitFor(500)).toBe(50);
  });

  test("separates required and optional text validation", () => {
    expect(required("  value  ", "field", 10)).toBe("value");
    expect(optionalText("   ", "field", 10)).toBeNull();
    expect(() => required("", "field", 10)).toThrow("field is required");
  });
});
