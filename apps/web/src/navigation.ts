import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export type ReviewView = "summary" | "tour" | "browse" | "review";
export type ReviewScope = "full" | "update";
export type NavigationMode = "push" | "replace";

export interface ReviewLocation {
  view: ReviewView;
  scope?: ReviewScope;
  stop?: string;
  file?: string;
}

interface ReviewHistoryState {
  wingdiffBack?: string;
}

const REVIEW_PARAMETERS = ["view", "scope", "stop", "file"] as const;

export function parseReviewLocation(search: string): ReviewLocation {
  const parameters = new URLSearchParams(search);
  const requestedView = parameters.get("view");
  const view: ReviewView = requestedView === "tour" || requestedView === "browse" || requestedView === "review" ? requestedView : "summary";
  const scope = parameters.get("scope");
  const stop = parameters.get("stop")?.trim();
  const file = parameters.get("file")?.trim();
  return {
    view,
    ...(scope === "full" || scope === "update" ? { scope } : {}),
    ...(view === "tour" && stop ? { stop } : {}),
    ...(view === "browse" && file ? { file } : {}),
  };
}

/** Rewrites only the review parameters, so the session or demo route survives. */
export function reviewLocationSearch(search: string, location: ReviewLocation): string {
  const parameters = new URLSearchParams(search);
  for (const name of REVIEW_PARAMETERS) parameters.delete(name);
  if (location.view !== "summary") parameters.set("view", location.view);
  if (location.scope) parameters.set("scope", location.scope);
  if (location.view === "tour" && location.stop) parameters.set("stop", location.stop);
  if (location.view === "browse" && location.file) parameters.set("file", location.file);
  const serialized = parameters.toString();
  return serialized ? `?${serialized}` : "";
}

/** The in-review entry the current one was opened from, if the reviewer has not left the review since. */
export function previousReviewSearch(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const back = (state as ReviewHistoryState).wingdiffBack;
  return typeof back === "string" ? back : undefined;
}

function canonicalSearch(search: string): string {
  return reviewLocationSearch(search, parseReviewLocation(search));
}

/** Updates the current entry without re-rendering, for position that changes while scrolling. */
export function replaceReviewLocation(location: ReviewLocation) {
  const current = canonicalSearch(window.location.search);
  if (parseReviewLocation(current).view !== location.view) return;
  const search = reviewLocationSearch(current, location);
  if (search === current) return;
  try {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}`);
  } catch {
    // Browsers rate-limit history writes; the next position change will catch up.
  }
}

/**
 * Keeps the open review view in the URL so browser Back, Forward and reload stay inside the review.
 * Moving between views pushes an entry; moving within a view replaces it, so Back always returns
 * to wherever the reviewer came from rather than replaying every stop.
 */
export function useReviewLocation() {
  const [location, setLocation] = useState<ReviewLocation>(() => parseReviewLocation(window.location.search));
  // history.back() lands asynchronously; until it does, a repeated action would pop a second entry.
  const traversing = useRef(false);

  useEffect(() => {
    const sync = () => {
      traversing.current = false;
      setLocation(parseReviewLocation(window.location.search));
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const navigate = useCallback((next: ReviewLocation, mode: NavigationMode = "push") => {
    if (traversing.current) return;
    const current = canonicalSearch(window.location.search);
    const search = reviewLocationSearch(current, next);
    if (search !== current) {
      const url = `${window.location.pathname}${search}`;
      if (mode === "push" && previousReviewSearch(window.history.state) === search) {
        // Returning to where we came from pops instead of growing the stack.
        traversing.current = true;
        window.history.back();
        return;
      }
      try {
        if (mode === "replace") window.history.replaceState(window.history.state, "", url);
        else window.history.pushState({ wingdiffBack: current } satisfies ReviewHistoryState, "", url);
      } catch {
        // Browsers rate-limit history writes; the view still moves and the next write will catch up.
      }
    }
    setLocation(next);
  }, []);

  const back = useCallback((fallback: ReviewLocation) => {
    if (traversing.current) return;
    if (previousReviewSearch(window.history.state) !== undefined) {
      traversing.current = true;
      window.history.back();
    } else {
      navigate(fallback);
    }
  }, [navigate]);

  return { location, navigate, back };
}

/** Restores the scroll offset of the place the reviewer returns to; anywhere new starts at the top. */
export function useScrollMemory(container: RefObject<HTMLElement | null>, slot: string, token: string) {
  const positions = useRef(new Map<string, { token: string; top: number }>());

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const saved = positions.current.get(slot);
    element.scrollTop = saved?.token === token ? saved.top : 0;
    const remember = () => positions.current.set(slot, { token, top: element.scrollTop });
    remember();
    element.addEventListener("scroll", remember, { passive: true });
    return () => element.removeEventListener("scroll", remember);
  }, [container, slot, token]);
}

/** The key of a plain shortcut press, or null while typing or holding a modifier. */
export function shortcutKey(event: KeyboardEvent): string | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const target = event.target;
  if (target instanceof HTMLElement && target.matches("input, textarea, select, [contenteditable='true']")) return null;
  return event.key;
}
