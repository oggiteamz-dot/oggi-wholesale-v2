// OGGI Wholesale v2 — shared reduced-motion helper (Batch 13)
//
// Every animation module in js/lib/animations/ checks this before running
// anything continuous or large-motion (flying elements, confetti, auto-
// rotate, pointer-follow tilt). Per the PRD's accessibility requirement
// and WCAG 2.3.3 (Animation from Interactions), a user with
// `prefers-reduced-motion: reduce` set at the OS level must still get the
// FUNCTIONAL outcome (item added, order confirmed, product visible) —
// just without the large/continuous motion. This is checked live via
// matchMedia, not cached at module load, so it responds correctly if the
// OS setting changes while the app is open (matchMedia's `matches` is
// re-evaluated on every call, and a 'change' listener is also exposed for
// callers that want to react live).

export function prefersReducedMotion() {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Calls `onChange(matches)` immediately and again whenever the OS setting
 * changes while this page is open. Returns an unsubscribe function. */
export function watchReducedMotion(onChange) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
  onChange(mql.matches);
  const handler = (e) => onChange(e.matches);
  if (mql.addEventListener) mql.addEventListener("change", handler);
  else if (mql.addListener) mql.addListener(handler); // Safari <14 fallback
  return () => {
    if (mql.removeEventListener) mql.removeEventListener("change", handler);
    else if (mql.removeListener) mql.removeListener(handler);
  };
}
