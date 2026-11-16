const system = "Answer in English in one or two short sentences. Use plain text.";
const providerTimeoutMs = 30_000;
const unavailableReply = "Sorry, the free AI services couldn’t respond. Try again in a moment.";

export interface Turn {
  prompt: string;
  reply: string;
}

interface Provider {
  name: string;
  docs: string;
  stream(prompt: string, history: Turn[], signal: AbortSignal): AsyncIterable<string>;
}

type ChatUpdate =
  | { type: "delta"; text: string }
  | { type: "retry" }
  | { type: "unavailable"; text: string };

async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() + "\n" : decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) yield line;
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function requestStream(endpoint: string, contentType: string, body: object, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Chat endpoint returned HTTP ${response.status}`);
  }
  return response.body;
}

const providers: readonly Provider[] = [
  {
    name: "mlvoca",
    docs: "https://mlvoca.github.io/free-llm-api/",
    async *stream(prompt, history, signal) {
      const previous = history.flatMap((turn) => [`User: ${turn.prompt}`, `Assistant: ${turn.reply}`]);
      const endpoint = import.meta.env.VITE_CHAT_ENDPOINT || "https://mlvoca.com/api/generate";
      // mlvoca accepts JSON in a simple POST without a CORS preflight.
      const body = await requestStream(endpoint, "text/plain;charset=UTF-8", {
        model: "tinyllama",
        system,
        prompt: previous.length ? [...previous, `User: ${prompt}`, "Assistant:"].join("\n") : prompt,
        stream: true,
        options: { num_predict: 96 },
      }, signal);

      for await (const line of readLines(body)) {
        const chunk = JSON.parse(line);
        if (chunk.error) throw new Error("mlvoca ended the reply");
        if (typeof chunk.response === "string" && chunk.response) yield chunk.response;
        if (chunk.done === true) return;
      }
      throw new Error("mlvoca interrupted the reply");
    },
  },
  {
    name: "Pollinations",
    docs: "https://github.com/pollinations/pollinations/blob/master/APIDOCS.md#text",
    async *stream(prompt, history, signal) {
      const messages = [
        { role: "system", content: system },
        ...history.flatMap((turn) => [
          { role: "user", content: turn.prompt },
          { role: "assistant", content: turn.reply },
        ]),
        { role: "user", content: prompt },
      ];
      const body = await requestStream("https://text.pollinations.ai/openai", "application/json", {
        model: "gpt-oss-20b",
        messages,
        stream: true,
        max_tokens: 512,
      }, signal);

      for await (const line of readLines(body)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        const chunk = JSON.parse(data);
        if (chunk.error) throw new Error("Pollinations ended the reply");
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) yield delta;
      }
      throw new Error("Pollinations interrupted the reply");
    },
  },
];

export const chatServices = providers.map(({ name, docs }) => ({ name, docs }));

export async function* chatReply(prompt: string, history: Turn[], signal: AbortSignal): AsyncGenerator<ChatUpdate> {
  const previous = history.slice(-3);
  const start = Math.floor(Math.random() * providers.length);
  for (let offset = 0; offset < providers.length; offset++) {
    signal.throwIfAborted();
    if (offset > 0) yield { type: "retry" };
    const provider = providers[(start + offset) % providers.length]!;
    const attempt = new AbortController();
    const cancel = () => attempt.abort(signal.reason);
    const timeout = setTimeout(() => attempt.abort(), providerTimeoutMs);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();

    try {
      let hasText = false;
      for await (const text of provider.stream(prompt, previous, attempt.signal)) {
        hasText ||= !!text.trim();
        yield { type: "delta", text };
      }
      signal.throwIfAborted();
      if (hasText) return;
    } catch {
      signal.throwIfAborted();
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
    }
  }
  signal.throwIfAborted();
  yield { type: "unavailable", text: unavailableReply };
}
