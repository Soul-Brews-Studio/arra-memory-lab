export type ThemeName = "sunflower" | "starry" | "iris";

export interface ThemeDefinition {
  value: ThemeName;
  label: string;
  note: string;
  colorScheme: "light" | "dark";
  themeColor: string;
}

export const DEFAULT_THEME: ThemeName = "sunflower";
export const THEME_STORAGE_KEY = "arra-memory-lab-theme";
export const THEMES: readonly ThemeDefinition[] = [
  { value: "sunflower", label: "Sunflower", note: "bright ochre and cobalt", colorScheme: "light", themeColor: "#f8efc7" },
  { value: "starry", label: "Starry", note: "deep blue and gold", colorScheme: "dark", themeColor: "#07152e" },
  { value: "iris", label: "Iris", note: "violet, teal, and coral", colorScheme: "light", themeColor: "#eee8f5" }
] as const;

interface ThemeStorage {
  getItem(key: string): string | null;
  setItem?(key: string, value: string): void;
}

interface ThemeDocument {
  documentElement: {
    dataset: DOMStringMap;
    style: Pick<CSSStyleDeclaration, "colorScheme">;
  };
  querySelector(selector: string): { setAttribute(name: string, value: string): void } | null;
}

function browserStorage(): ThemeStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function resolveTheme(value: unknown): ThemeName {
  return THEMES.some((theme) => theme.value === value) ? value as ThemeName : DEFAULT_THEME;
}

export function readStoredTheme(storage?: Pick<ThemeStorage, "getItem">): ThemeName {
  try {
    return resolveTheme((storage ?? browserStorage())?.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(
  value: unknown,
  documentTarget: ThemeDocument = globalThis.document,
  storage?: ThemeStorage
): ThemeName {
  const theme = resolveTheme(value);
  const definition = THEMES.find((candidate) => candidate.value === theme)!;

  documentTarget.documentElement.dataset.theme = theme;
  documentTarget.documentElement.style.colorScheme = definition.colorScheme;
  documentTarget.querySelector('meta[name="theme-color"]')?.setAttribute("content", definition.themeColor);
  try {
    (storage ?? browserStorage())?.setItem?.(THEME_STORAGE_KEY, theme);
  } catch {
    // Persistence is optional; the selected palette still applies to this page.
  }
  return theme;
}
