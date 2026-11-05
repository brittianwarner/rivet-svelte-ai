/** Coalesce full-text checkpoints while bounding memory and preserving delta semantics. */
export async function consumeResponse(
  stream: AsyncIterable<string>,
  options: {
    maxLength: number;
    signal: AbortSignal;
    publish: (content: string, delta: string) => void;
    now?: () => number;
    intervalMs?: number;
  },
): Promise<{ content: string; limited: boolean }> {
  const now = options.now ?? Date.now;
  const interval = options.intervalMs ?? 100;
  let content = "";
  let published = "";
  let lastPublish = -Infinity;
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
    }
  } finally {
    // Preserve the last partial chunk on completion, cancellation, or provider failure.
    publish();
  }
  return { content, limited: content.length >= options.maxLength };
}
