import { describe, expect, test } from "bun:test";
import {
  limitFor,
  optionalText,
  projectText,
  provenanceTags,
  required
} from "./domain-utils";

describe("domain utility contracts", () => {
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
