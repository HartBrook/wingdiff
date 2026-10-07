// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceReviewLocation, useReviewLocation, useScrollMemory } from "./navigation";

function nextPop() {
  return new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
}

function settle() {
  return new Promise<void>((resolve) => setTimeout(resolve, 30));
}

beforeEach(() => {
  // A fresh entry per test drops any forward entries the previous one left behind.
  window.history.pushState(null, "", "/?session=s");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useReviewLocation", () => {
  it("pushes an entry that remembers where it came from when the view changes", () => {
    const { result } = renderHook(() => useReviewLocation());
    const length = window.history.length;

    act(() => result.current.navigate({ view: "tour", stop: "atomic-counter" }));

    expect(window.location.search).toBe("?session=s&view=tour&stop=atomic-counter");
    expect(window.history.state).toEqual({ wingdiffBack: "?session=s" });
    expect(window.history.length).toBe(length + 1);
    expect(result.current.location).toEqual({ view: "tour", stop: "atomic-counter" });
  });

  it("replaces the entry and keeps its state when asked to", () => {
    const { result } = renderHook(() => useReviewLocation());
    act(() => result.current.navigate({ view: "tour", stop: "first" }));
    const length = window.history.length;

    act(() => result.current.navigate({ view: "tour", stop: "second" }, "replace"));

    expect(window.location.search).toBe("?session=s&view=tour&stop=second");
    expect(window.history.state).toEqual({ wingdiffBack: "?session=s" });
    expect(window.history.length).toBe(length);
    expect(result.current.location).toEqual({ view: "tour", stop: "second" });
  });

  it("pops instead of pushing when returning to the entry it came from", async () => {
    const { result } = renderHook(() => useReviewLocation());
    act(() => result.current.navigate({ view: "tour", stop: "first" }));

    await act(async () => {
      const popped = nextPop();
      result.current.navigate({ view: "summary" });
      await popped;
    });

    expect(window.location.search).toBe("?session=s");
    expect(window.history.state).toBeNull();
    expect(result.current.location).toEqual({ view: "summary" });
  });

  it("goes back one entry however often the action repeats", async () => {
    const { result } = renderHook(() => useReviewLocation());
    act(() => result.current.navigate({ view: "tour", stop: "first" }));
    act(() => result.current.navigate({ view: "review" }));

    await act(async () => {
      const popped = nextPop();
      result.current.back({ view: "summary" });
      result.current.back({ view: "summary" });
      result.current.navigate({ view: "tour", stop: "first" });
      await popped;
      await settle();
    });

    expect(window.location.search).toBe("?session=s&view=tour&stop=first");
    expect(result.current.location).toEqual({ view: "tour", stop: "first" });

    // The guard lifts once the traversal lands.
    act(() => result.current.navigate({ view: "browse" }));
    expect(window.location.search).toBe("?session=s&view=browse");
  });

  it("opens the fallback when there is no in-review entry to go back to", () => {
    window.history.replaceState(null, "", "/?session=s&view=review");
    const { result } = renderHook(() => useReviewLocation());
    const length = window.history.length;

    act(() => result.current.back({ view: "tour", stop: "first" }));

    expect(window.location.search).toBe("?session=s&view=tour&stop=first");
    expect(window.history.length).toBe(length + 1);
    expect(result.current.location).toEqual({ view: "tour", stop: "first" });
  });

  it("follows browser back and forward", async () => {
    const { result } = renderHook(() => useReviewLocation());
    act(() => result.current.navigate({ view: "browse", file: "session-0-src/a.ts" }));

    await act(async () => {
      const popped = nextPop();
      window.history.back();
      await popped;
    });
    expect(result.current.location).toEqual({ view: "summary" });

    await act(async () => {
      const popped = nextPop();
      window.history.forward();
      await popped;
    });
    expect(result.current.location).toEqual({ view: "browse", file: "session-0-src/a.ts" });
  });

  it("still moves the view when the browser refuses the history write", () => {
    const { result } = renderHook(() => useReviewLocation());
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {
      throw new DOMException("Too many calls", "SecurityError");
    });

    act(() => result.current.navigate({ view: "tour", stop: "first" }, "replace"));

    expect(window.location.search).toBe("?session=s");
    expect(result.current.location).toEqual({ view: "tour", stop: "first" });
  });
});

describe("replaceReviewLocation", () => {
  it("rewrites the current entry in place", () => {
    window.history.replaceState({ wingdiffBack: "?session=s" }, "", "/?session=s&view=browse");
    const length = window.history.length;

    replaceReviewLocation({ view: "browse", file: "session-1-src/b.ts" });

    expect(window.location.search).toBe("?session=s&view=browse&file=session-1-src%2Fb.ts");
    expect(window.history.state).toEqual({ wingdiffBack: "?session=s" });
    expect(window.history.length).toBe(length);
  });

  it("ignores a position reported for a view that is no longer open", () => {
    window.history.replaceState(null, "", "/?session=s&view=tour&stop=first");

    replaceReviewLocation({ view: "browse", file: "session-1-src/b.ts" });

    expect(window.location.search).toBe("?session=s&view=tour&stop=first");
  });
});

describe("useScrollMemory", () => {
  function renderScrollMemory() {
    const container = { current: document.createElement("main") };
    const hook = renderHook(({ slot, token }: { slot: string; token: string }) => useScrollMemory(container, slot, token), {
      initialProps: { slot: "tour", token: "full:first" },
    });
    const scrollTo = (top: number) => {
      container.current.scrollTop = top;
      container.current.dispatchEvent(new Event("scroll"));
    };
    return { element: container.current, scrollTo, ...hook };
  }

  it("restores the offset of a place the reviewer returns to", () => {
    const { element, rerender, scrollTo } = renderScrollMemory();
    scrollTo(120);

    rerender({ slot: "review", token: "full" });
    expect(element.scrollTop).toBe(0);
    scrollTo(40);

    rerender({ slot: "tour", token: "full:first" });
    expect(element.scrollTop).toBe(120);
  });

  it("starts at the top when the slot now shows something else", () => {
    const { element, rerender, scrollTo } = renderScrollMemory();
    scrollTo(120);

    rerender({ slot: "review", token: "full" });
    rerender({ slot: "tour", token: "full:second" });

    expect(element.scrollTop).toBe(0);
  });
});
