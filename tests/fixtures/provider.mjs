// Test-process-only transport. Exercise the actual SDK parser without paid calls.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).hostname !== "openrouter.ai")
    return originalFetch(input, init);
  const payload = await request.json();
  const prompt = payload.messages.at(-1)?.content ?? "";
  if (prompt.includes("[fail]")) {
    return Response.json(
      { error: { message: "Deterministic provider failure" } },
      { status: 401 },
    );
  }
  const chunks = prompt.includes("[slow]")
    ? ["Partial reply", ...Array.from({ length: 40 }, () => " continuing")]
    : ["Hello", " from the", " local model."];
  let timer;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let index = 0;
      const emit = (delta, finish_reason = null) =>
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
          ),
        );
      timer = setInterval(() => {
        if (request.signal.aborted) {
          clearInterval(timer);
          controller.error(request.signal.reason);
          return;
        }
        if (index < chunks.length) emit({ content: chunks[index++] });
        else {
          clearInterval(timer);
          emit({}, "stop");
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      }, 200);
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
};
