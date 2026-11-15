// Free-model aggregator for the free-model-aggregator-02 trial.
// One Node 22 server: it serves OpenAI Chat Completions and Anthropic
// Messages on both wires, dials a real OpenRouter free model through the
// grader's gateway for every prompt, registers its catalog with the env,
// and exits 0 once the env says the work is done. On a refused model
// call it retries the next-best model that meets the prompt and reports
// the refusal trail in the x-makefun-upstream-failures header.

import http from "node:http";
import { loadBrief, buildCatalog, catalogText, emptyCatalogText } from "./lib/brief.ts";
import { pickModel, type Need } from "./lib/pick.ts";
import { postChat, postChatStream, type UpstreamFailure } from "./lib/upstream.ts";
import {
  anthropicContentBlockDelta,
  anthropicContentBlockStart,
  anthropicContentBlockStop,
  anthropicError,
  anthropicMessageDelta,
  anthropicMessageStart,
  anthropicMessageStop,
  anthropicToChat,
  capTokens,
  chatToAnthropicReply,
  chatToOpenAiReply,
  needFromAnthropic,
  needFromOpenAi,
  openAiChatParts,
  openAiChunk,
  openAiDone,
  openAiError,
  openAiUsage,
} from "./lib/wire.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const MAX_ATTEMPTS = 3;
const UPSTREAM_TIMEOUT_MS = 25000;
const RETRY_DELAY_MS = 400;
const POLL_DELAY_MS = 400;
const REGISTER_ATTEMPTS = 5;

const args = process.argv.slice(2);
const listMode = args.includes("--list");
const envUrl = process.env.MAKEFUN_ENV_URL;
const promptFile = process.env.MAKEFUN_PROMPT_FILE;
const openAiBase = process.env.OPENAI_BASE_URL;
const openAiKey = process.env.OPENAI_API_KEY;

function trialNowMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n > 1e12 ? n : n * 1000;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

const trialNow = trialNowMs();
const trialNowSec = Math.floor(trialNow / 1000);
const trialNowIso = trialNow > 0 ? new Date(trialNow).toISOString() : "1970-01-01T00:00:00Z";

let reqCounter = 0;

if (listMode) {
  const brief = loadBrief(promptFile);
  process.stdout.write((brief ? catalogText(brief.models) : emptyCatalogText()) + "\n");
  process.exit(0);
}

if (!envUrl || !promptFile || !openAiBase || !openAiKey) {
  console.error("missing trial environment: MAKEFUN_ENV_URL, MAKEFUN_PROMPT_FILE, OPENAI_BASE_URL, OPENAI_API_KEY");
  process.exit(1);
}

const brief = loadBrief(promptFile);
if (!brief) {
  console.error("cannot read the brief at MAKEFUN_PROMPT_FILE");
  process.exit(1);
}

const catalog = buildCatalog(brief.models);

type Served =
  | {
      model: string;
      failures: UpstreamFailure[];
      json?: any;
      streamed?: {
        text: string;
        toolCalls: { id: string; name: string; args: string }[];
        finishReason: string | null;
        usage: any;
      };
    }
  | { failures: UpstreamFailure[] };

function trailHeaders(failures: UpstreamFailure[]): Record<string, string> {
  if (!failures.length) return {};
  return { "x-makefun-upstream-failures": JSON.stringify(failures.slice(0, 8)) };
}

async function servePrompt(
  need: Need,
  stream: boolean,
  buildBody: (model: string) => any,
): Promise<Served> {
  const tried = new Set<string>();
  const failures: UpstreamFailure[] = [];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const model = pickModel(brief.models, need, tried);
    if (!model) break;
    tried.add(model.id);
    const body = buildBody(model.id);
    if (stream) {
      const res = await postChatStream(openAiBase, openAiKey, body, UPSTREAM_TIMEOUT_MS);
      if (res.ok) {
        return {
          model: model.id,
          failures,
          streamed: { text: res.text, toolCalls: res.toolCalls, finishReason: res.finishReason, usage: res.usage },
        };
      }
      failures.push({ status: res.status, code: res.code, model: model.id });
    } else {
      const res = await postChat(openAiBase, openAiKey, body, UPSTREAM_TIMEOUT_MS);
      if (res.ok) return { model: model.id, failures, json: res.json };
      failures.push({ status: res.status, code: res.code, model: model.id });
    }
    await sleep(RETRY_DELAY_MS);
  }
  return { failures };
}

function sendJson(res: http.ServerResponse, status: number, payload: any, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...extra });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function modelsReply(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.headers["x-api-key"]) {
    const data = brief.models.map((m) => ({
      id: m.id,
      type: "model",
      display_name: m.display_name,
      created_at: trialNowIso,
    }));
    sendJson(res, 200, {
      object: "list",
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
    });
  } else {
    const data = brief.models.map((m) => ({ id: m.id, object: "model", created: trialNowSec, owned_by: "openrouter" }));
    sendJson(res, 200, { object: "list", data });
  }
}

async function handleOpenAi(req: http.IncomingMessage, res: http.ServerResponse, bodyText: string): Promise<void> {
  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, openAiError("invalid_request_error", "body is not valid JSON"));
    return;
  }
  const need = needFromOpenAi(body);
  const parts = openAiChatParts(body);
  const maxTokens = capTokens(body.max_tokens ?? body.max_completion_tokens);
  const stream = body.stream === true;
  const id = `chatcmpl-${++reqCounter}`;
  const result = await servePrompt(need, stream, (model) => {
    const upstream: any = { model, messages: parts.messages, max_tokens: maxTokens, stream };
    if (parts.temperature !== undefined) upstream.temperature = parts.temperature;
    if (parts.topP !== undefined) upstream.top_p = parts.topP;
    if (parts.tools) {
      upstream.tools = parts.tools;
      if (parts.toolChoice !== undefined) upstream.tool_choice = parts.toolChoice;
    }
    if (parts.responseFormat) upstream.response_format = parts.responseFormat;
    if (parts.stop !== undefined) upstream.stop = parts.stop;
    if (stream) upstream.stream_options = { include_usage: true };
    return upstream;
  });
  const headers = trailHeaders(result.failures);
  if (!("model" in result)) {
    sendJson(res, 502, openAiError("server_error", "upstream failed"), headers);
    return;
  }
  if (!stream) {
    sendJson(res, 200, chatToOpenAiReply(result.model, result.json, id, trialNowSec), headers);
    return;
  }
  const streamed = result.streamed!;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...headers });
  res.write(openAiChunk(id, trialNowSec, result.model, { role: "assistant", content: "" }, null, null));
  if (streamed.text) {
    res.write(openAiChunk(id, trialNowSec, result.model, { content: streamed.text }, null, null));
  }
  const finalDelta: any = {};
  if (streamed.toolCalls.length) {
    finalDelta.tool_calls = streamed.toolCalls.map((tc, i) => ({
      index: i,
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.args },
    }));
  }
  const usage = openAiUsage(streamed.usage, streamed.text);
  res.write(openAiChunk(id, trialNowSec, result.model, finalDelta, streamed.finishReason ?? "stop", usage));
  res.write(openAiDone());
  res.end();
}

async function handleAnthropic(req: http.IncomingMessage, res: http.ServerResponse, bodyText: string): Promise<void> {
  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch {
    sendJson(res, 400, anthropicError("invalid_request_error", "body is not valid JSON"));
    return;
  }
  const need = needFromAnthropic(body);
  const parts = anthropicToChat(body);
  const maxTokens = capTokens(body.max_tokens);
  const stream = body.stream === true;
  const id = `msg-${++reqCounter}`;
  const result = await servePrompt(need, stream, (model) => {
    const upstream: any = { model, messages: parts.messages, max_tokens: maxTokens, stream };
    if (parts.temperature !== undefined) upstream.temperature = parts.temperature;
    if (parts.topP !== undefined) upstream.top_p = parts.topP;
    if (parts.tools) {
      upstream.tools = parts.tools;
      if (parts.toolChoice !== undefined) upstream.tool_choice = parts.toolChoice;
    }
    if (parts.stop !== undefined) upstream.stop = parts.stop;
    if (stream) upstream.stream_options = { include_usage: true };
    return upstream;
  });
  const headers = trailHeaders(result.failures);
  if (!("model" in result)) {
    sendJson(res, 502, anthropicError("api_error", "upstream failed"), headers);
    return;
  }
  if (!stream) {
    sendJson(res, 200, chatToAnthropicReply(result.model, result.json, id), headers);
    return;
  }
  const s = result.streamed!;
  const inputTokens = Math.max(0, Math.floor(Number(s.usage?.prompt_tokens ?? 0)));
  const outputTokens =
    typeof s.usage?.completion_tokens === "number"
      ? Math.max(1, Math.floor(s.usage.completion_tokens))
      : Math.max(1, Math.ceil(s.text.length / 4));
  const stopReason = s.finishReason === "tool_calls" ? "tool_use" : s.finishReason === "length" ? "max_tokens" : "end_turn";
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...headers });
  res.write(anthropicMessageStart(id, result.model, inputTokens));
  let index = 0;
  if (s.text) {
    res.write(anthropicContentBlockStart(0, { type: "text", text: "" }));
    res.write(anthropicContentBlockDelta(0, { type: "text_delta", text: s.text }));
    res.write(anthropicContentBlockStop(0));
    index = 1;
  }
  for (const tc of s.toolCalls) {
    let input: any = {};
    try {
      input = JSON.parse(tc.args || "{}");
    } catch {
      input = {};
    }
    res.write(anthropicContentBlockStart(index, { type: "tool_use", id: tc.id, name: tc.name, input: {} }));
    res.write(anthropicContentBlockDelta(index, { type: "input_json_delta", partial_json: tc.args }));
    res.write(anthropicContentBlockStop(index));
    index++;
  }
  res.write(anthropicMessageDelta(stopReason, outputTokens));
  res.write(anthropicMessageStop());
  res.end();
}

const server = http.createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/v1/models") {
        modelsReply(req, res);
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const text = await readBody(req);
        await handleOpenAi(req, res, text);
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/messages") {
        const text = await readBody(req);
        await handleAnthropic(req, res, text);
        return;
      }
      sendJson(res, 404, openAiError("not_found", "not found"));
    } catch (err) {
      console.error("handler error", err);
      if (!res.headersSent) {
        sendJson(res, 500, openAiError("server_error", "internal error"));
      } else {
        try {
          res.end();
        } catch {
          // already closing
        }
      }
    }
  })();
});

async function register(port: number): Promise<void> {
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocol_version: 1, port, catalog }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data: any = await res.json().catch(() => ({}));
        console.error(`registered port=${port} requests=${data?.requests ?? "?"}`);
        return;
      }
      console.error(`register attempt ${attempt} status ${res.status}`);
    } catch (err) {
      console.error(`register attempt ${attempt} failed`, err);
    }
    await sleep(500);
  }
  throw new Error("register failed");
}

async function waitForDone(): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/work`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data: any = await res.json().catch(() => null);
        if (data && data.done === true) return;
      }
    } catch {
      // the env may hiccup; keep polling
    }
    await sleep(POLL_DELAY_MS);
  }
}

await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
await register(port);
console.error(`serving on port ${port}`);
await waitForDone();
server.close();
process.exit(0);
