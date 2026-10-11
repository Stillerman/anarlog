import { expect, it, vi } from "vitest";

it("blocks vendor and telemetry requests while allowing platform and local model requests", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => new Response("allowed"));
  try {
    await import("./network-policy");
    for (const url of [
      "https://api.anarlog.so/sync",
      "https://us.i.posthog.com/capture",
      "https://ingest.sentry.io/envelope",
    ]) {
      await expect(fetch(url)).rejects.toThrow(
        "Upstream services are unavailable",
      );
    }
    expect(
      await (
        await fetch("https://workspace.example/jason/ingest/company")
      ).text(),
    ).toBe("allowed");
    expect(await (await fetch("http://localhost:11434/api/chat")).text()).toBe(
      "allowed",
    );
  } finally {
    globalThis.fetch = original;
  }
});
