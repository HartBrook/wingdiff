export type ReviewPublicationOutcome = "not-published" | "uncertain";

export class ReviewPublicationError extends Error {
  constructor(message: string, readonly outcome: ReviewPublicationOutcome) {
    super(message);
    this.name = "ReviewPublicationError";
  }
}

export function publicationErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
