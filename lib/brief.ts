// Brief parsing for the free-model-aggregator-02 trial.
// The brief file (MAKEFUN_PROMPT_FILE) is prose with two embedded JSON
// documents: the prompts manifest and the free-model list. We pull those
// two documents out by their schema marker and parse them. Each document
// sits on exactly one line, so a line scan keyed on its schema is enough;
// anything else in the file is prose the server ignores.

import { readFileSync } from "node:fs";

export type ModelInfo = {
  id: string;
  rating_milli: number;
  context_length: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
  display_name: string;
};

export type PromptNeed = { tools: boolean; vision: boolean; json: boolean };

export type PromptSpec = {
  id: string;
  api: string;
  stream: boolean;
  weight: number;
  requires: PromptNeed;
};

export type Brief = { models: ModelInfo[]; prompts: PromptSpec[] };

const PROMPTS_SCHEMA = "free-model-aggregator-02/prompts/v1";
const MODELS_SCHEMA = "free-model-aggregator-02/models/v1";

function extractDoc(text: string, schema: string): any | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.includes(`"schema":"${schema}"`)) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function loadBrief(path: string | undefined): Brief | null {
  if (!path) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const promptsDoc = extractDoc(text, PROMPTS_SCHEMA);
  const modelsDoc = extractDoc(text, MODELS_SCHEMA);
  if (!promptsDoc || !modelsDoc) return null;
  const models: ModelInfo[] = (modelsDoc.models ?? [])
    .map((m: any) => ({
      id: String(m.id ?? ""),
      rating_milli: Number(m.rating_milli ?? 0),
      context_length: m.context_length ?? null,
      tools: m.tools === true,
      vision: m.vision === true,
      json: m.json === true,
      display_name: String(m.display_name ?? m.id ?? ""),
    }))
    .filter((m: ModelInfo) => m.id !== "");
  const prompts: PromptSpec[] = (promptsDoc.prompts ?? [])
    .map((p: any) => ({
      id: String(p.id ?? ""),
      api: String(p.api ?? ""),
      stream: p.stream === true,
      weight: Number(p.weight ?? 1),
      requires: {
        tools: p.requires?.tools === true,
        vision: p.requires?.vision === true,
        json: p.requires?.json === true,
      },
    }))
    .filter((p: PromptSpec) => p.id !== "");
  if (models.length === 0) return null;
  return { models, prompts };
}

export function buildCatalog(models: ModelInfo[]): Record<string, unknown> {
  return {
    providers: [
      {
        id: "openrouter",
        base_url: "https://openrouter.ai/api/v1",
        key_env: "OPENROUTER_API_KEY",
        wire: "openai",
        models: models.map((model) => ({
          id: model.id,
          free: true,
          context_length: model.context_length,
        })),
      },
    ],
  };
}

export function catalogText(models: ModelInfo[]): string {
  return JSON.stringify(buildCatalog(models));
}

export function emptyCatalogText(): string {
  return JSON.stringify({ providers: [] });
}
