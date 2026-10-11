import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
import { SendToAgentDialog } from "./send-to-agent";

beforeEach(() => {
  vi.clearAllMocks();
});

it("shows a saved retry after an uncertain send and confirms only the ingestion receipt", async () => {
  let attempts = 0;
  const deliveryIds: string[] = [];
  native.invoke.mockImplementation(
    async (name: string, input?: { deliveryId: string }) => {
      if (name.endsWith("platform_targets"))
        return [
          {
            id: "james",
            name: "James",
            configured: true,
            endpoint: "https://workspace.example/jason/ingest/company",
          },
        ];
      if (name.endsWith("preview_platform_meeting"))
        return {
          deliveryId: "snapshot-id",
          payload: {
            title: "Planning",
            text: "Speaker: We agreed to ship Tuesday.",
          },
          receipt: null,
        };
      if (name.endsWith("send_platform_meeting")) {
        deliveryIds.push(input!.deliveryId);
        if (attempts++ === 0)
          throw new Error("Delivery could not be confirmed.");
        return {
          recorded: true,
          artifactId: "artifact",
          eventId: "ingest:event",
        };
      }
      throw new Error("Unexpected command");
    },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SendToAgentDialog
        sessionId="meeting"
        agent="james"
        open
        onOpenChange={() => {}}
      />
    </QueryClientProvider>,
  );
  await screen.findByText("Speaker: We agreed to ship Tuesday.");
  expect(deliveryIds).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Send to James" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry saved meeting" }),
  );
  await screen.findByText("ingest:event");
  expect(
    screen.getByRole("button", { name: "Recorded" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(deliveryIds).toEqual(["snapshot-id", "snapshot-id"]);
  client.clear();
});
