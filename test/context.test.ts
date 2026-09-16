import { describe, expect, test } from "bun:test";
import { extract, oneLine, wrap, shortModel } from "../src/context.ts";

const L = (o: unknown) => JSON.stringify(o);

describe("extract — reconstructing 'which session is this?' from the tail", () => {
  const lines = [
    L({ type: "user", gitBranch: "feat/boot-gate" }),
    L({ type: "assistant", message: { content: [{ type: "text", text: "First reply." }] } }),
    L({ type: "pr-link", prNumber: 920, prUrl: "https://example.test/pull/920" }),
    L({ type: "assistant", message: { content: [{ type: "text", text: "Decisive: DI throws early." }] } }),
    L({ type: "last-prompt", lastPrompt: "can you do this same boot error problem in crm also." }),
    L({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
  ];

  test("prefers the most recent of each field, scanning backwards", () => {
    const k = extract(lines);
    expect(k.pr).toBe(920);
    expect(k.branch).toBe("feat/boot-gate");
    expect(k.lastPrompt).toContain("crm also");
    expect(k.lastSay).toBe("Decisive: DI throws early.");
  });

  test("skips tool_use records — they are not something a human can read", () => {
    expect(extract(lines).lastSay).not.toContain("Bash");
  });

  test("a torn first line in the tail is skipped, not fatal", () => {
    const torn = ['{"type":"assist', ...lines];
    expect(extract(torn).pr).toBe(920);
  });

  test("ignores a detached-HEAD branch, which names nothing useful", () => {
    expect(extract([L({ type: "user", gitBranch: "HEAD" })]).branch).toBeUndefined();
  });

  test("an empty or contentless transcript yields an empty context, not a throw", () => {
    expect(extract([])).toEqual({});
    expect(extract([L({ type: "mode", mode: "normal" })])).toEqual({});
  });

  test("an assistant record with no text blocks does not become lastSay", () => {
    const only = [L({ type: "assistant", message: { content: [{ type: "tool_use" }] } })];
    expect(extract(only).lastSay).toBeUndefined();
  });
});

describe("oneLine / wrap", () => {
  test("oneLine collapses whitespace and ellipsises at the limit", () => {
    expect(oneLine("a\n\n  b   c", 20)).toBe("a b c");
    expect(oneLine("x".repeat(50), 10)).toHaveLength(10);
    expect(oneLine("x".repeat(50), 10).endsWith("…")).toBe(true);
    expect(oneLine(undefined, 10)).toBe("");
  });

  test("wrap breaks on words and indents every line", () => {
    const out = wrap("one two three four five six seven", 12, "    ");
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((l) => l.startsWith("    "))).toBe(true);
    expect(out.every((l) => l.length <= 12 + 4)).toBe(true);
  });

  test("wrap does not lose a word longer than the width", () => {
    expect(wrap("supercalifragilistic", 5, "").join(" ")).toContain("supercalifragilistic");
  });
});

describe("shortModel", () => {
  test("strips the vendor prefix", () => {
    expect(shortModel("claude-opus-5")).toBe("opus-5");
    expect(shortModel("claude-sonnet-5")).toBe("sonnet-5");
  });

  test("drops a trailing release date and reads the point version", () => {
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("haiku-4.5");
  });

  test("treats <synthetic> as no model — it is a locally generated record", () => {
    // One live session showed this. Taking it at face value would have printed
    // "<synthetic>" as if it were a model the user had selected.
    expect(shortModel("<synthetic>")).toBe("");
    expect(shortModel(undefined)).toBe("");
    expect(shortModel("")).toBe("");
  });

  test("passes through an unrecognised id rather than hiding it", () => {
    expect(shortModel("some-future-model")).toBe("some-future-model");
  });
});

describe("extract — model", () => {
  test("takes the model from the most recent real assistant record", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5", content: [] } }),
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-5", content: [] } }),
    ];
    expect(extract(lines).model).toBe("claude-opus-5");
  });

  test("skips <synthetic> and keeps looking further back", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-5", content: [] } }),
      JSON.stringify({ type: "assistant", message: { model: "<synthetic>", content: [] } }),
    ];
    expect(extract(lines).model).toBe("claude-opus-5");
  });

  test("no assistant record means no model, not a guess", () => {
    expect(extract([JSON.stringify({ type: "user" })]).model).toBeUndefined();
  });
});
