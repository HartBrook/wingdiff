import { describe, expect, it } from "vitest";
import { parseReviewLocation, previousReviewSearch, reviewLocationSearch } from "./navigation";

describe("review navigation", () => {
  it("defaults to the summary and ignores unknown values", () => {
    expect(parseReviewLocation("?session=local-123")).toEqual({ view: "summary" });
    expect(parseReviewLocation("?session=local-123&view=settings&scope=everything")).toEqual({ view: "summary" });
  });

  it("reads the stop or file only for the view that owns it", () => {
    expect(parseReviewLocation("?session=s&view=tour&scope=update&stop=atomic-counter&file=src%2Fa.ts")).toEqual({
      view: "tour",
      scope: "update",
      stop: "atomic-counter",
    });
    expect(parseReviewLocation("?session=s&view=browse&stop=atomic-counter&file=src%2Fa.ts")).toEqual({
      view: "browse",
      file: "src/a.ts",
    });
  });

  it("rewrites review parameters while keeping the session route", () => {
    const tour = reviewLocationSearch("?session=local-123", { view: "tour", stop: "atomic-counter" });
    expect(tour).toBe("?session=local-123&view=tour&stop=atomic-counter");
    expect(reviewLocationSearch(tour, { view: "browse", file: "session-0-src/counter.ts" })).toBe("?session=local-123&view=browse&file=session-0-src%2Fcounter.ts");
    expect(reviewLocationSearch(tour, { view: "summary" })).toBe("?session=local-123");
    expect(reviewLocationSearch("?demo=1&view=review", { view: "summary", scope: "full" })).toBe("?demo=1&scope=full");
  });

  it("round-trips every location it writes", () => {
    for (const location of [
      { view: "summary" as const },
      { view: "tour" as const, scope: "update" as const, stop: "stop with spaces" },
      { view: "browse" as const, scope: "full" as const, file: "session-0-src/a b.ts" },
      { view: "review" as const },
    ]) {
      expect(parseReviewLocation(reviewLocationSearch("?session=s", location))).toEqual(location);
    }
  });

  it("only trusts history state written by the review", () => {
    expect(previousReviewSearch({ wingdiffBack: "?session=s" })).toBe("?session=s");
    expect(previousReviewSearch({})).toBeUndefined();
    expect(previousReviewSearch(null)).toBeUndefined();
    expect(previousReviewSearch({ wingdiffBack: 3 })).toBeUndefined();
  });
});
