/**
 * Not a client module on purpose: the server layout imports the script string from here.
 * It runs before first paint so the right theme class is on <html> with no flash.
 * Keep in sync with `applyTheme` in theme-provider.tsx.
 */
export const THEME_STORAGE_KEY = "pulseboard-theme";

export const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem("${THEME_STORAGE_KEY}");var d=p==="dark"||((p===null||p==="system")&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);document.documentElement.style.colorScheme=d?"dark":"light";}catch(e){}})();`;
