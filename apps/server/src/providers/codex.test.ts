import { describe, expect, it } from "vitest";
import {
  CODEX_SECURITY_OVERRIDES,
  codexInvestigationTimeoutMs,
  codexModelArguments,
  codexTourTimeoutMs,
  formatCodexCliError,
} from "./codex.js";

describe("Codex CLI isolation", () => {
  it("prevents model-invoked tools from inheriting secrets or browsing", () => {
    expect(CODEX_SECURITY_OVERRIDES).toEqual([
      "-c",
      'shell_environment_policy.inherit="none"',
      "-c",
      "tools.web_search=false",
    ]);
  });

  it("lets the CLI choose the signed-in account's default model", () => {
    expect(codexModelArguments("codex-default")).toEqual([]);
    expect(codexModelArguments("gpt-6-sol")).toEqual(["--model", "gpt-6-sol"]);
  });
});

describe("Codex CLI timeouts", () => {
  it("allows ten minutes for tours and three minutes for investigations by default", () => {
    expect(codexTourTimeoutMs({})).toBe(600_000);
    expect(codexInvestigationTimeoutMs({})).toBe(180_000);
  });

  it("supports request-specific overrides with the legacy shared override as a fallback", () => {
    const shared = { WINGDIFF_CODEX_TIMEOUT_MS: "240000" };
    expect(codexTourTimeoutMs(shared)).toBe(240_000);
    expect(codexInvestigationTimeoutMs(shared)).toBe(240_000);

    const specific = {
      ...shared,
      WINGDIFF_CODEX_TOUR_TIMEOUT_MS: "720000",
      WINGDIFF_CODEX_INVESTIGATION_TIMEOUT_MS: "90000",
    };
    expect(codexTourTimeoutMs(specific)).toBe(720_000);
    expect(codexInvestigationTimeoutMs(specific)).toBe(90_000);
  });

  it("ignores invalid or sub-second overrides", () => {
    expect(codexTourTimeoutMs({ WINGDIFF_CODEX_TOUR_TIMEOUT_MS: "soon" })).toBe(600_000);
    expect(codexInvestigationTimeoutMs({ WINGDIFF_CODEX_INVESTIGATION_TIMEOUT_MS: "999" })).toBe(180_000);
  });
});

describe("Codex CLI errors", () => {
  it("turns a ChatGPT model rejection into an actionable provider choice", () => {
    const stderr = 'ERROR request failed: {"status":400,"detail":"The gpt-5.3-codex model is not supported when using Codex with a ChatGPT account."}';
    expect(formatCodexCliError(stderr, "codex-default")).toBe(
      "Codex's account-default model is not available with this ChatGPT account. Update Codex CLI and run `codex login` again, or select OpenAI API and configure OPENAI_API_KEY.",
    );
  });

  it("explains how to recover when Codex authentication expires", () => {
    expect(formatCodexCliError("Error: 401 Unauthorized: authentication expired", "gpt-6-sol")).toBe(
      "Codex authentication is missing or expired. Run `codex login`, then restart Wingdiff.",
    );
  });

  it("extracts a structured error detail instead of exposing CLI log noise", () => {
    const stderr = '2026-10-07T12:00:00Z ERROR codex_core::client: {"error":{"message":"The request was rejected."}}';
    expect(formatCodexCliError(stderr, "gpt-6-sol")).toBe("The request was rejected.");
  });

  it("recognizes the unsupported wording of a ChatGPT model rejection", () => {
    const stderr = "ERROR: The gpt-6-sol model is unsupported when using Codex with a ChatGPT account.";
    expect(formatCodexCliError(stderr, "gpt-6-sol")).toMatch(/^gpt-6-sol is not available with this ChatGPT account\./);
  });

  it("recognizes a structured 401 status", () => {
    expect(formatCodexCliError('ERROR: {"status":401,"detail":"Token rejected."}', "codex-default")).toBe(
      "Codex authentication is missing or expired. Run `codex login`, then restart Wingdiff.",
    );
  });

  it("explains a model that the current sign-in cannot use", () => {
    const stderr = "ERROR: The model `gpt-6-astra` does not exist or you do not have access to it.";
    expect(formatCodexCliError(stderr, "codex-default")).toBe(
      "Codex's account-default model is not available with the current Codex sign-in. Update Codex CLI and run `codex login` again, or choose another provider.",
    );
  });

  it("does not mistake echoed review evidence for an authentication failure", () => {
    const stderr = [
      '+  if (res.status === 401) throw new Error("Unauthorized");',
      "ERROR: stream disconnected before completion: You have hit your usage limit.",
    ].join("\n");
    expect(formatCodexCliError(stderr, "codex-default")).toBe(
      "stream disconnected before completion: You have hit your usage limit.",
    );
  });

  it("does not mistake model prose for an unavailable model", () => {
    const stderr = "The data model for sessions is not supported by the old migration.\nERROR: stream error: connection reset";
    expect(formatCodexCliError(stderr, "codex-default")).toBe("stream error: connection reset");
  });

  it("reports the error instead of a trailing warning", () => {
    const stderr = [
      "ERROR: unexpected status 429 Too Many Requests: rate limit reached",
      "Warning: no last agent message; wrote empty content to /tmp/wingdiff-codex-abc/tour-output.json",
    ].join("\n");
    expect(formatCodexCliError(stderr, "codex-default")).toBe("unexpected status 429 Too Many Requests: rate limit reached");
  });

  it("ignores structured fields that are not part of the error line", () => {
    const stderr = 'ssage":"truncated"}\n{"path":"src/a.ts","message":"fix retry"}\nERROR: stream error: connection reset';
    expect(formatCodexCliError(stderr, "codex-default")).toBe("stream error: connection reset");
  });

  it("keeps the whole stderr tail when no line reports an error", () => {
    const stderr = "thread panicked at core/src/lib.rs\nstack backtrace omitted";
    expect(formatCodexCliError(stderr, "codex-default")).toBe(stderr);
    expect(formatCodexCliError("Not logged in. Run codex login.", "codex-default")).toMatch(/^Codex authentication is missing or expired\./);
  });

  it("returns nothing for empty stderr so the caller reports the exit status", () => {
    expect(formatCodexCliError("", "codex-default")).toBe("");
    expect(formatCodexCliError("WARNING: proceeding, even though we could not create PATH aliases: denied\n")).toBe("");
  });
});
