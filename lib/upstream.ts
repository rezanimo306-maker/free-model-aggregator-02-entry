// Minimal Chat Completions client for the make.fun gateway.
// Speaks only to $OPENAI_BASE_URL/chat/completions, the one route the
// gateway serves for the free models this competition allows. Anthropic
// requests are translated to this route by the caller, never sent to the
// gateway's Messages route (it refuses these ids there).

export type UpstreamFailure = { status: number; code: string; model: string | null };

export type ChatResult = { ok: true; json: any } | { ok: false; status: number; code: string };

export type StreamResult =
  | {
      ok: true;
      text: string;
      toolCalls: { id: string; name: string; args: string }[];
      finishReason: string | null;
      usage: any;
    }
  | { ok: false; status: number; code: string };

// A refusal carries the provider's own error shape: prefer its error
// code, then its error type, and only then fall back to the HTTP status.
// The code is what the failover trail header reports for the call.
function errorCode(status: number, bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText);
    const err = parsed?.error;
    if (typeof err === "string" && err) return err;
    if (err && typeof err.code === "string" && err.code) return err.code;
    if (err && typeof err.type === "string" && err.type) return err.type;
  } catch {
    // not JSON: fall through to the status-based code
  }
  return `http_${status}`;
}

export async function postChat(
  baseUrl: string,
  apiKey: string,
  body: any,
  timeoutMs: number,
): Promise<ChatResult> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    return { ok: false, status: 0, code: err?.name === "TimeoutError" ? "timeout" : "network_error" };
  }
  const raw = await res.text().catch(() => "");
  if (!res.ok) return { ok: false, status: res.status, code: errorCode(res.status, raw) };
  try {
    return { ok: true, json: JSON.parse(raw) };
  } catch {
    return { ok: false, status: 200, code: "bad_upstream_body" };
  }
}

export async function postChatStream(
  baseUrl: string,
  apiKey: string,
  body: any,
  timeoutMs: number,
): Promise<StreamResult> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    return { ok: false, status: 0, code: err?.name === "TimeoutError" ? "timeout" : "network_error" };
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    return { ok: false, status: res.status, code: errorCode(res.status, raw) };
  }
  const reader = res.body?.getReader();
  if (!reader) return { ok: false, status: 200, code: "bad_upstream_body" };
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let finishReason: string | null = null;
  let usage: any = null;
  const toolCallsByIndex = new Map<number, { id: string; name: string; args: string }>();
  const flush = (chunk: string) => {
    buffer += chunk.replace(/\r\n/g, "\n");
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of event.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = parsed?.choices?.[0];
        if (!choice) {
          if (parsed?.usage) usage = parsed.usage;
          continue;
        }
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content) text += delta.content;
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const at = Number(tc.index ?? 0);
            const cur = toolCallsByIndex.get(at) ?? { id: "", name: "", args: "" };
            if (typeof tc.id === "string" && tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (typeof tc.function?.arguments === "string") cur.args += tc.function.arguments;
            toolCallsByIndex.set(at, cur);
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (parsed?.usage) usage = parsed.usage;
      }
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      flush(decoder.decode(value, { stream: true }));
    }
    flush(decoder.decode());
  } catch {
    return { ok: false, status: 0, code: "network_error" };
  }
  const toolCalls = [...toolCallsByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
  return { ok: true, text, toolCalls, finishReason, usage };
}
