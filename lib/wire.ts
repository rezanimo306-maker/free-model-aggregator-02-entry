// Wire translation for the free-model-aggregator-02 trial.
// The server answers both client wires (OpenAI Chat Completions and
// Anthropic Messages) while every model is dialled on Chat Completions.
// This file translates requests into Chat Completions bodies, translates
// Chat Completions answers back into each wire, and builds the streaming
// event sequences each wire expects.

import type { Need } from "./pick.ts";

export function capTokens(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 1024;
  if (n < 1) return 1;
  if (n > 8192) return 8192;
  return n;
}

export function needFromOpenAi(body: any): Need {
  const tools = Array.isArray(body?.tools) && body.tools.length > 0;
  const json = !!body?.response_format;
  let vision = false;
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (Array.isArray(m?.content)) {
      for (const part of m.content) {
        if (part?.type === "image_url" || part?.type === "input_image") vision = true;
      }
    }
  }
  return { tools, vision, json };
}

export function needFromAnthropic(body: any): Need {
  const tools = Array.isArray(body?.tools) && body.tools.length > 0;
  let vision = false;
  const scan = (content: any) => {
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "image") vision = true;
      }
    }
  };
  for (const m of Array.isArray(body?.messages) ? body.messages : []) scan(m?.content);
  scan(body?.system);
  return { tools, vision, json: false };
}

export function openAiChatParts(body: any): {
  messages: any;
  tools: any;
  toolChoice: any;
  responseFormat: any;
  stop: any;
  temperature: any;
  topP: any;
} {
  return {
    messages: Array.isArray(body?.messages) ? body.messages : [],
    tools: Array.isArray(body?.tools) ? body.tools : undefined,
    toolChoice: body?.tool_choice,
    responseFormat: body?.response_format,
    stop: body?.stop,
    temperature: typeof body?.temperature === "number" ? body.temperature : undefined,
    topP: typeof body?.top_p === "number" ? body.top_p : undefined,
  };
}

// Anthropic content blocks expand into Chat Completions messages in
// order: text blocks join into one message, image blocks become their
// own image message, tool uses attach to their assistant message, and a
// tool result becomes a tool message of its own. Nothing is reordered,
// so the conversation the model sees is the one the client sent.
export function anthropicToChat(body: any): {
  messages: any[];
  tools: any;
  toolChoice: any;
  stop: any;
  temperature: any;
  topP: any;
} {
  const messages: any[] = [];
  const system = body?.system;
  if (typeof system === "string" && system) {
    messages.push({ role: "system", content: system });
  } else if (Array.isArray(system)) {
    const text = system
      .filter((b: any) => b?.type === "text")
      .map((b: any) => String(b.text ?? ""))
      .join("\n");
    if (text) messages.push({ role: "system", content: text });
  }
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    const role = m?.role === "assistant" ? "assistant" : "user";
    const content = m?.content;
    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const textParts: string[] = [];
    const toolCalls: any[] = [];
    for (const part of content) {
      if (part?.type === "text") {
        textParts.push(String(part.text ?? ""));
      } else if (part?.type === "image") {
        const src = part.source ?? {};
        if (src.type === "base64") {
          if (textParts.length) {
            messages.push({ role, content: textParts.join("\n") });
            textParts.length = 0;
          }
          messages.push({
            role,
            content: [
              {
                type: "image_url",
                image_url: { url: `data:${src.media_type ?? "image/jpeg"};base64,${src.data ?? ""}` },
              },
            ],
          });
        }
      } else if (part?.type === "tool_use" && role === "assistant") {
        toolCalls.push({
          id: String(part.id ?? ""),
          type: "function",
          function: { name: String(part.name ?? ""), arguments: JSON.stringify(part.input ?? {}) },
        });
      } else if (part?.type === "tool_result" && role === "user") {
        if (textParts.length) {
          messages.push({ role, content: textParts.join("\n") });
          textParts.length = 0;
        }
        const resultText =
          typeof part.content === "string"
            ? part.content
            : Array.isArray(part.content)
              ? part.content
                  .filter((b: any) => b?.type === "text")
                  .map((b: any) => String(b.text ?? ""))
                  .join("\n")
              : "";
        messages.push({ role: "tool", tool_call_id: String(part.tool_use_id ?? ""), content: resultText });
      }
    }
    if (textParts.length) messages.push({ role, content: textParts.join("\n") });
    if (toolCalls.length) {
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant" && !last.tool_calls) {
        last.tool_calls = toolCalls;
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: toolCalls });
      }
    }
  }
  const tools = Array.isArray(body?.tools)
    ? body.tools.map((t: any) => ({
        type: "function",
        function: {
          name: String(t?.name ?? ""),
          description: typeof t?.description === "string" ? t.description : undefined,
          parameters: t?.input_schema ?? { type: "object", properties: {} },
        },
      }))
    : undefined;
  const choice = body?.tool_choice;
  let toolChoice: any;
  if (choice?.type === "auto") toolChoice = "auto";
  else if (choice?.type === "any") toolChoice = "required";
  else if (choice?.type === "none") toolChoice = "none";
  else if (choice?.type === "tool" && typeof choice.name === "string") {
    toolChoice = { type: "function", function: { name: choice.name } };
  }
  return {
    messages,
    tools,
    toolChoice,
    stop: Array.isArray(body?.stop_sequences) ? body.stop_sequences : undefined,
    temperature: typeof body?.temperature === "number" ? body.temperature : undefined,
    topP: typeof body?.top_p === "number" ? body.top_p : undefined,
  };
}

export function openAiUsage(usage: any, contentText: string): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const prompt = Math.max(0, Math.floor(Number(usage?.prompt_tokens ?? 0)));
  const completion =
    typeof usage?.completion_tokens === "number"
      ? Math.max(1, Math.floor(usage.completion_tokens))
      : Math.max(1, Math.ceil(contentText.length / 4));
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

export function chatToOpenAiReply(dialed: string, chat: any, id: string, created: number): any {
  const choice = chat?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const finish = typeof choice.finish_reason === "string" ? choice.finish_reason : "stop";
  const replyText = typeof msg.content === "string" ? msg.content : null;
  const message: any = { role: "assistant", content: replyText };
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) message.tool_calls = msg.tool_calls;
  return {
    id,
    object: "chat.completion",
    created,
    model: dialed,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: openAiUsage(chat?.usage, replyText ?? ""),
  };
}

export function chatToAnthropicReply(dialed: string, chat: any, id: string): any {
  const choice = chat?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content: any[] = [];
  if (typeof msg.content === "string" && msg.content) {
    content.push({ type: "text", text: msg.content });
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input: any = {};
      try {
        input = JSON.parse(tc.function?.arguments ?? "{}");
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: String(tc.id ?? ""),
        name: String(tc.function?.name ?? ""),
        input,
      });
    }
  }
  if (!content.length) content.push({ type: "text", text: "" });
  const finish = choice.finish_reason;
  const stopReason = finish === "tool_calls" ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn";
  const usage = chat?.usage ?? {};
  const inputTokens = Math.max(0, Math.floor(Number(usage.prompt_tokens ?? 0)));
  const outputTokens =
    typeof usage.completion_tokens === "number"
      ? Math.max(1, Math.floor(usage.completion_tokens))
      : Math.max(1, Math.ceil((typeof msg.content === "string" ? msg.content.length : 0) / 4));
  return {
    id,
    type: "message",
    role: "assistant",
    model: dialed,
    content,
    stop_reason: stopReason,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

export function openAiError(code: string, message: string): any {
  return { error: { message, type: code, code } };
}

export function anthropicError(type: string, message: string): any {
  return { type: "error", error: { type, message } };
}

export function sseLine(payload: any): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function openAiChunk(
  id: string,
  created: number,
  dialed: string,
  delta: any,
  finishReason: string | null,
  usage: any | null,
): string {
  const choice: any = { index: 0, delta };
  if (finishReason) choice.finish_reason = finishReason;
  const chunk: any = { id, object: "chat.completion.chunk", created, model: dialed, choices: [choice] };
  if (usage) chunk.usage = usage;
  return sseLine(chunk);
}

export function openAiDone(): string {
  return "data: [DONE]\n\n";
}

export function anthropicMessageStart(id: string, dialed: string, inputTokens: number): string {
  return sseLine({
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: dialed,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
}

export function anthropicContentBlockStart(index: number, block: any): string {
  return sseLine({ type: "content_block_start", index, content_block: block });
}

export function anthropicContentBlockDelta(index: number, delta: any): string {
  return sseLine({ type: "content_block_delta", index, delta });
}

export function anthropicContentBlockStop(index: number): string {
  return sseLine({ type: "content_block_stop", index });
}

export function anthropicMessageDelta(stopReason: string, outputTokens: number): string {
  return sseLine({
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
}

export function anthropicMessageStop(): string {
  return sseLine({ type: "message_stop" });
}
