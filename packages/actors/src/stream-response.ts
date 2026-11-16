/**
 * Coalesce full-text updates while bounding memory and preserving delta
 * semantics. `publish` (broadcast) runs at most every `intervalMs`, plus once
 * at the end; `checkpoint` (a durable write) runs at most every
 * `checkpointMs` while streaming. The caller writes the final text itself.
 */
export async function consumeResponse(
  stream: AsyncIterable<string>,
  options: {
    maxLength: number;
    signal: AbortSignal;
    publish: (content: string, delta: string) => void;
    checkpoint?: (content: string) => Promise<void>;
    now?: () => number;
    intervalMs?: number;
    checkpointMs?: number;
  },
): Promise<{ content: string; limited: boolean }> {
  const now = options.now ?? Date.now;
  const interval = options.intervalMs ?? 100;
  const checkpointInterval = options.checkpointMs ?? 1_000;
  let content = "";
  let published = "";
  let lastPublish = -Infinity;
  let checkpointed = "";
  let lastCheckpoint = now();
  const publish = () => {
    if (content === published) return;
    options.publish(content, content.slice(published.length));
    published = content;
    lastPublish = now();
  };
  try {
    for await (const delta of stream) {
      if (options.signal.aborted) break;
      content = (content + delta).slice(0, options.maxLength);
      if (now() - lastPublish >= interval) publish();
      if (content.length >= options.maxLength) break;
      if (
        options.checkpoint &&
        content !== checkpointed &&
        now() - lastCheckpoint >= checkpointInterval
      ) {
        await options.checkpoint(content);
        checkpointed = content;
        lastCheckpoint = now();
      }
    }
  } finally {
    // Preserve the last partial chunk on completion, cancellation, or provider failure.
    publish();
  }
  return { content, limited: content.length >= options.maxLength };
}
