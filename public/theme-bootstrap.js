(() => {
  const themes = {
    sunflower: { colorScheme: "light", themeColor: "#f8efc7" },
    starry: { colorScheme: "dark", themeColor: "#07152e" },
    iris: { colorScheme: "light", themeColor: "#eee8f5" }
  };
  let storedTheme;
  try {
    storedTheme = localStorage.getItem("arra-memory-lab-theme");
  } catch {
    storedTheme = undefined;
  }
  const themeName = Object.hasOwn(themes, storedTheme) ? storedTheme : "sunflower";
  const theme = themes[themeName];
  document.documentElement.dataset.theme = themeName;
  document.documentElement.style.colorScheme = theme.colorScheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.themeColor);
})();
