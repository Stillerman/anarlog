// Block accidental vendor service calls in the webview, including code added by
// later upstream merges. The native HTTP bridge has matching scope denials.
export function blockedService(input: string | URL | Request): boolean {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    globalThis.location?.href ?? "http://localhost",
  );
  return [
    "anarlog.so",
    "hyprnote.com",
    "hyprnote.so",
    "char.com",
    "fastrepl.com",
    "posthog.com",
    "sentry.io",
  ].some((base) => url.hostname === base || url.hostname.endsWith(`.${base}`));
}
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) =>
  blockedService(input)
    ? Promise.reject(
        new Error("Upstream services are unavailable in this fork."),
      )
    : originalFetch(input, init);
const OriginalWebSocket = globalThis.WebSocket;
if (OriginalWebSocket) {
  globalThis.WebSocket = class extends OriginalWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      if (blockedService(url))
        throw new Error("Upstream services are unavailable in this fork.");
      super(url, protocols);
    }
  };
}
if (globalThis.XMLHttpRequest) {
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async: boolean = true,
    username?: string | null,
    password?: string | null,
  ) {
    if (blockedService(url))
      throw new Error("Upstream services are unavailable in this fork.");
    originalOpen.call(this, method, url, async, username, password);
  };
}
if (typeof globalThis.navigator?.sendBeacon === "function") {
  const originalBeacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = (url, data) =>
    blockedService(url) ? false : originalBeacon(url, data);
}
