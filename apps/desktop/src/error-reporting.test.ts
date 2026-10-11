import { describe, expect, it, vi } from "vitest";

import {
  captureOperationalError,
  normalizeOperationalError,
  operationalErrorMetadata,
  sanitizeErrorEvent,
} from "./error-reporting";

const creditBalanceMessage =
  "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

describe("normalizeOperationalError", () => {
  it("removes structured, primitive, and arbitrary object failure messages", () => {
    expect(
      normalizeOperationalError(
        {
          status: 403,
          code: "subscription_required",
          message: "A Pro subscription is required",
          responseBody: "private response body",
        },
        "integration_connect",
      ).message,
    ).toBe("integration_connect failed");
    expect(
      normalizeOperationalError("connection refused", "sync").message,
    ).toBe("sync failed");
    expect(
      normalizeOperationalError({ transcript: "private transcript" }, "sync")
        .message,
    ).toBe("sync failed");
  });

  it("extracts only privacy-safe operational diagnostics", () => {
    expect(
      operationalErrorMetadata({
        name: "ApiError",
        code: "subscription_required",
        stage: "billing_check",
        statusCode: 403,
        message: "private@example.com",
      }),
    ).toEqual({
      type: "ApiError",
      code: "subscription_required",
      stage: "billing_check",
      status: 403,
    });
    expect(
      operationalErrorMetadata({
        code: "private email@example.com",
        stage: "billing check",
        status: 999,
      }),
    ).toEqual({
      type: "Error",
      code: undefined,
      stage: undefined,
      status: undefined,
    });
  });
});

describe("sanitizeErrorEvent", () => {
  it("keeps diagnostics while removing user and request data", () => {
    const event = sanitizeErrorEvent({
      type: undefined,
      user: {
        id: "user-1",
        email: "private@example.com",
        ip_address: "127.0.0.1",
      },
      request: {
        method: "POST",
        url: "https://anarlog.so/note/123?token=secret#selection",
        headers: { authorization: "Bearer secret" },
        data: { note: "private note" },
      },
      message: "private@example.com opened a private note",
      logentry: {
        message: "token=secret",
      },
      exception: {
        values: [
          {
            type: "RouteError",
            value: "private note content",
            mechanism: {
              type: "generic",
              handled: false,
              data: { token: "secret" },
            },
            module: "/Users/alice/private.ts",
            stacktrace: {
              frames: [
                {
                  filename: "https://anarlog.so/app?token=secret",
                  function: "saveSession",
                  lineno: 42,
                  vars: { transcript: "private transcript" },
                },
              ],
            },
          },
        ],
      },
      extra: { transcript: "private transcript" },
      breadcrumbs: [
        {
          category: "console",
          message: "private note",
          data: { arguments: ["private note"] },
        },
        {
          category: "navigation",
          data: {
            from: "https://anarlog.so/?token=secret",
            to: "https://anarlog.so/app/?share=secret",
          },
        },
      ],
    });

    expect(event?.user).toBeUndefined();
    expect(event?.request).toBeUndefined();
    expect(event?.extra).toBeUndefined();
    expect(event?.message).toBeUndefined();
    expect(event?.logentry).toBeUndefined();
    expect(event?.exception?.values).toEqual([
      {
        type: "RouteError",
        value: "RouteError captured",
        mechanism: {
          type: "generic",
          handled: false,
        },
        stacktrace: {
          frames: [
            {
              colno: undefined,
              filename: "source",
              function: "saveSession",
              in_app: undefined,
              lineno: 42,
            },
          ],
        },
      },
    ]);
    expect(event?.breadcrumbs).toEqual([
      {
        category: "console",
        level: undefined,
        timestamp: undefined,
        type: undefined,
      },
      {
        category: "navigation",
        level: undefined,
        timestamp: undefined,
        type: undefined,
      },
    ]);
  });
});

describe("user-caused failures", () => {
  it("drops account and credential failures before they reach Sentry", () => {
    expect(
      sanitizeErrorEvent({
        type: undefined,
        exception: {
          values: [{ type: "ProviderError", value: creditBalanceMessage }],
        },
      }),
    ).toBeNull();
    expect(
      sanitizeErrorEvent({
        type: undefined,
        extra: { "error.code": "insufficient_quota" },
      }),
    ).toBeNull();
  });

  it("keeps errors whose only match is an earlier breadcrumb", () => {
    expect(
      sanitizeErrorEvent({
        type: undefined,
        exception: { values: [{ type: "RouteError", value: "boom" }] },
        breadcrumbs: [{ category: "http", message: creditBalanceMessage }],
      }),
    ).not.toBeNull();
  });
});

describe("captureOperationalError", () => {
  it("keeps operational diagnostics local without leaking source error messages", () => {
    const localLog = vi.spyOn(console, "error").mockImplementation(() => {});
    captureOperationalError(new Error(creditBalanceMessage), {
      operation: "chat_completion",
    });
    captureOperationalError(
      new Error("[runBatch] error handling batch response"),
      { operation: "batch_persist" },
    );

    captureOperationalError(new Error("socket hang up"), {
      operation: "chat_completion",
    });

    expect(localLog.mock.calls).toEqual([
      [
        "chat_completion",
        { type: "Error", code: undefined, stage: undefined, status: undefined },
      ],
    ]);
    localLog.mockRestore();
  });
});

describe("archived operational noise", () => {
  it("drops archived issue types before they reach Sentry", () => {
    expect(
      sanitizeErrorEvent({
        type: undefined,
        message:
          '[String("[runBatch] error handling batch response"), Object {}]',
      }),
    ).toBeNull();
    expect(
      sanitizeErrorEvent({
        type: undefined,
        exception: {
          values: [
            {
              type: "Error",
              value: "[listener] post-stop transcript repair failed",
            },
          ],
        },
      }),
    ).toBeNull();
    expect(
      sanitizeErrorEvent({
        type: undefined,
        logger: "tauri_plugin_tracing::ext",
        message: "native_error:tauri_plugin_tracing::ext:35",
      }),
    ).toBeNull();
  });
});
