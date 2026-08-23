import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  THEMES,
  applyTheme,
  readStoredTheme,
  resolveTheme
} from "./theme";

describe("theme contracts", () => {
  test("accepts every declared theme", () => {
    for (const theme of THEMES) expect(resolveTheme(theme.value)).toBe(theme.value);
  });

  test("uses Sunflower when a stored theme is invalid", () => {
    const storage = { getItem: () => "neon-rainbow" };
    expect(readStoredTheme(storage)).toBe(DEFAULT_THEME);
  });

  test("uses Sunflower when theme storage cannot be read", () => {
    const storage = { getItem: () => { throw new Error("blocked"); } };
    expect(readStoredTheme(storage)).toBe(DEFAULT_THEME);
  });

  test("applies theme attributes even when persistence is unavailable", () => {
    const attributes = new Map<string, string>();
    const documentTarget = {
      documentElement: { dataset: {} as DOMStringMap, style: { colorScheme: "" } },
      querySelector: () => ({ setAttribute: (name: string, value: string) => attributes.set(name, value) })
    };
    const storage = {
      getItem: () => null,
      setItem: () => { throw new Error("blocked"); }
    };

    expect(applyTheme("starry", documentTarget, storage)).toBe("starry");
    expect(documentTarget.documentElement.dataset.theme).toBe("starry");
    expect(documentTarget.documentElement.style.colorScheme).toBe("dark");
    expect(attributes.get("content")).toBe("#07152e");
  });

  test("persists the selected theme under the stable storage key", () => {
    const writes: [string, string][] = [];
    const documentTarget = {
      documentElement: { dataset: {} as DOMStringMap, style: { colorScheme: "" } },
      querySelector: () => null
    };
    const storage = { getItem: () => null, setItem: (key: string, value: string) => writes.push([key, value]) };

    applyTheme("iris", documentTarget, storage);
    expect(writes).toEqual([[THEME_STORAGE_KEY, "iris"]]);
  });

  test("loads the CSP-safe theme bootstrap before the client entry", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const bootstrap = html.indexOf('/theme-bootstrap.js');
    const clientEntry = html.indexOf("/src/client.tsx");
    expect(html).toContain('<html lang="en" data-theme="sunflower">');
    expect(html).toContain('<meta name="theme-color" content="#f8efc7" />');
    expect(html).toContain('<script src="/theme-bootstrap.js"></script>');
    expect(bootstrap).toBeGreaterThan(-1);
    expect(bootstrap).toBeLessThan(clientEntry);
  });

  test("does not require unsafe inline scripts for theme bootstrap", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>\s*\S/);
  });

  test("the classic bootstrap applies a valid stored palette before React", () => {
    const source = readFileSync(new URL("../public/theme-bootstrap.js", import.meta.url), "utf8");
    const dataset: Record<string, string> = {};
    const style = { colorScheme: "" };
    let themeColor = "#f8efc7";

    runInNewContext(source, {
      localStorage: { getItem: () => "starry" },
      document: {
        documentElement: { dataset, style },
        querySelector: () => ({ setAttribute: (_name: string, value: string) => { themeColor = value; } })
      }
    });

    expect(dataset.theme).toBe("starry");
    expect(style.colorScheme).toBe("dark");
    expect(themeColor).toBe("#07152e");
    expect(source).toContain(THEME_STORAGE_KEY);
    for (const theme of THEMES) {
      expect(source).toContain(theme.value);
      expect(source).toContain(theme.colorScheme);
      expect(source).toContain(theme.themeColor);
    }
  });

  test("the classic bootstrap fails safely to Sunflower when storage is blocked", () => {
    const source = readFileSync(new URL("../public/theme-bootstrap.js", import.meta.url), "utf8");
    const dataset: Record<string, string> = {};

    runInNewContext(source, {
      localStorage: { getItem: () => { throw new Error("blocked"); } },
      document: {
        documentElement: { dataset, style: { colorScheme: "" } },
        querySelector: () => null
      }
    });

    expect(dataset.theme).toBe(DEFAULT_THEME);
  });

  test("groups the palette controls with a native fieldset and legend", () => {
    const client = readFileSync(new URL("./client.tsx", import.meta.url), "utf8");
    expect(client).toContain('<fieldset className="theme-picker">');
    expect(client).toContain("<legend>Palette</legend>");
  });

  test("uses text-labelled native radio inputs for palette selection", () => {
    const client = readFileSync(new URL("./client.tsx", import.meta.url), "utf8");
    expect(client).toContain('<input type="radio" name="theme"');
    expect(client).toContain('<span className="theme-name">{option.label}</span>');
  });
});
