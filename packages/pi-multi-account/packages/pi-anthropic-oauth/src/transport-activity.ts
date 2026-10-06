/**
 * Byte-level transport liveness for one streamed Anthropic request.
 *
 * The Anthropic SDK drops the server's `ping` events before they reach a
 * stream consumer, so a model that thinks silently for minutes is
 * indistinguishable from a dead connection at the event level. A caller that
 * needs to tell them apart passes `onTransportActivity` in the request options;
 * this wrapper then reports every response body chunk (pings included) without
 * reading, buffering, or retaining its content.
 *
 * The callback receives no arguments. A throwing callback is contained so it
 * can never break the response. Without the option the SDK keeps its default
 * fetch and the request path is unchanged.
 */

export type TransportActivityListener = () => void;

export function transportActivityListener(
  options: unknown,
): TransportActivityListener | undefined {
  if (typeof options !== "object" || options === null) return undefined;
  const listener = (options as { onTransportActivity?: unknown })
    .onTransportActivity;
  return typeof listener === "function"
    ? (listener as TransportActivityListener)
    : undefined;
}

export function createTransportActivityFetch(
  onActivity: TransportActivityListener,
): typeof fetch {
  // Read the global at construction, as the SDK's own default does.
  const baseFetch = globalThis.fetch;
  const notify = (): void => {
    try {
      onActivity();
    } catch {
      // Liveness reporting is best-effort and must not break the response.
    }
  };
  return async (input, init) => {
    const response = await baseFetch(input, init);
    const body = response.body;
    if (body === null) return response;
    const observed = body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          notify();
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(observed, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
