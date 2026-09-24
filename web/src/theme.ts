// Light or dark: follows the device unless this device has been told otherwise (the switch in the top bar).
// The choice is per device, like the person using it. The page's palette hangs off <html data-theme>, which is
// set here as soon as the app loads (before anything is drawn) and kept in step with the device setting.
import { useSyncExternalStore } from "react";

export type ThemeChoice = "auto" | "light" | "dark";

const KEY = "housetrack.theme";
const deviceDark = typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: dark)") : undefined;
const listeners = new Set<() => void>();

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
}

let choice: ThemeChoice = read();

const resolved = () => (choice === "auto" ? (deviceDark?.matches ? "dark" : "light") : choice);

function apply() {
  if (typeof document === "undefined") return;
  const theme = resolved();
  document.documentElement.dataset.theme = theme;
  // The browser's own bar colour, matching the page rather than the device setting.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = theme === "dark" ? "#111416" : "#f4f0e8";
    meta.removeAttribute("media");
  }
  for (const fn of listeners) fn();
}

deviceDark?.addEventListener("change", apply);
apply();

export function setTheme(next: ThemeChoice) {
  choice = next;
  try {
    if (next === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch { /* private window: this visit only */ }
  apply();
}

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, () => choice);
}

/** Whether the page is dark right now (for colours picked in code: the grid, the map's basemap). */
export function useDarkMode(): boolean {
  return useSyncExternalStore(subscribe, () => resolved() === "dark");
}

export const isDark = () => resolved() === "dark";
