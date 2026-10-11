import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

import { Button } from "@anlg/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@anlg/ui/components/ui/dialog";

type Agent = "james" | "arkenza" | "kim";
type Target = {
  id: Agent;
  name: string;
  endpoint: string;
  configured: boolean;
};
type Receipt = { artifactId: string; eventId: string; recorded: true };
type Preview = {
  deliveryId: string;
  endpoint: string;
  payload: { title: string; text: string };
  receipt: Receipt | null;
};
const command = <T,>(name: string, args?: Record<string, unknown>) =>
  invoke<T>(`plugin:local-api|${name}`, args);
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function SendToAgentDialog({
  sessionId,
  agent,
  open,
  onOpenChange,
}: {
  sessionId: string;
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [secret, setSecret] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const targets = useQuery({
    queryKey: ["platform-targets"],
    queryFn: () => command<Target[]>("platform_targets"),
    enabled: open,
  });
  const target = targets.data?.find((t) => t.id === agent);
  const needsConfiguration = editing || target?.configured === false;
  const preview = useQuery({
    queryKey: ["platform-preview", sessionId, agent, target?.endpoint],
    queryFn: () =>
      command<Preview>("preview_platform_meeting", {
        agent,
        meetingId: sessionId,
      }),
    enabled: open && target?.configured === true && !editing,
    retry: false,
  });
  const configure = useMutation({
    mutationFn: () =>
      command<void>("configure_platform_target", {
        agent,
        endpoint: endpoint || target?.endpoint,
        secret,
      }),
    onSuccess: async () => {
      setSecret("");
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ["platform-targets"] });
      await queryClient.invalidateQueries({
        queryKey: ["platform-preview", sessionId, agent],
      });
    },
  });
  const send = useMutation({
    mutationFn: () =>
      command<Receipt>("send_platform_meeting", {
        deliveryId: preview.data?.deliveryId,
      }),
    onSuccess: (received) => {
      setReceipt(received);
      queryClient.setQueryData<Preview>(
        ["platform-preview", sessionId, agent, target?.endpoint],
        (value) => (value ? { ...value, receipt: received } : value),
      );
    },
  });
  const received = receipt ?? preview.data?.receipt;
  const close = (nextOpen: boolean) => {
    if (send.isPending || configure.isPending) return;
    if (!nextOpen) {
      setSecret("");
      setEndpoint("");
      setEditing(false);
      setReceipt(null);
      send.reset();
      configure.reset();
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogTitle>Send to {target?.name ?? agent}</DialogTitle>
        <DialogDescription>
          Share this meeting's notes, summary, and transcript with your agent.
          Audio stays on this device.
        </DialogDescription>
        {targets.isPending && <p role="status">Loading agent configuration…</p>}
        {targets.error && <p role="alert">{errorText(targets.error)}</p>}
        {needsConfiguration ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              configure.mutate();
            }}
          >
            <label className="flex flex-col gap-1">
              Ingestion endpoint
              <input
                className="rounded border p-2"
                type="url"
                required
                value={endpoint || target?.endpoint || ""}
                onChange={(event) => setEndpoint(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              Ingestion signing key
              <input
                className="rounded border p-2"
                type="password"
                required
                minLength={16}
                autoComplete="off"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
            </label>
            <p className="text-muted-foreground text-sm">
              Use this instance's ingestion key. It is saved in this app's
              private configuration on your computer.
            </p>
            {configure.error && (
              <p role="alert">{errorText(configure.error)}</p>
            )}
            <Button type="submit" disabled={configure.isPending}>
              {configure.isPending ? "Saving…" : "Save configuration"}
            </Button>
          </form>
        ) : target ? (
          <>
            <p className="text-sm break-all">Destination: {target.endpoint}</p>
            {preview.isFetching && <p role="status">Preparing meeting…</p>}
            {preview.error && <p role="alert">{errorText(preview.error)}</p>}
            {preview.data && !preview.isFetching && (
              <>
                <h3 className="font-medium">{preview.data.payload.title}</h3>
                <pre className="max-h-72 overflow-y-auto rounded border p-3 text-sm whitespace-pre-wrap">
                  {preview.data.payload.text}
                </pre>
                <p className="text-muted-foreground text-sm">
                  The platform records this meeting in Inbox and Events. Its
                  chat subscriptions control agent reactions.
                </p>
                {received && (
                  <p role="status">
                    Recorded by the platform. Event:{" "}
                    <code className="break-all">{received.eventId}</code>
                  </p>
                )}
                {send.error && <p role="alert">{errorText(send.error)}</p>}
                <Button
                  disabled={send.isPending || !!received}
                  onClick={() => send.mutate()}
                >
                  {received
                    ? "Recorded"
                    : send.isPending
                      ? "Sending…"
                      : send.error
                        ? "Retry saved meeting"
                        : `Send to ${target.name}`}
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              disabled={send.isPending}
              onClick={() => {
                setEndpoint(target.endpoint);
                setEditing(true);
              }}
            >
              Configure agent
            </Button>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
