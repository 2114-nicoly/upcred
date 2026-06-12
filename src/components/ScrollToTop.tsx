import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * Resets window + <main> scroll position on every route change.
 * Mounted once inside <BrowserRouter>.
 */
export default function ScrollToTop() {
  const { pathname, search } = useLocation();
  useEffect(() => {
    try {
      window.scrollTo({ top: 0, left: 0 });
      const main = document.querySelector("main");
      if (main) main.scrollTop = 0;
    } catch {
      /* noop */
    }
  }, [pathname, search]);
  return null;
}
