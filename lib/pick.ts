// Model choice for the free-model-aggregator-02 trial.
// Quality is the serving model's sealed rating over the best rating of a
// free model meeting the prompt's requirements, so for every prompt we
// serve with the highest-rated model that meets what the request asks for
// (tools, vision, JSON mode). Failover walks the same ranking downwards.
// Ties on rating break on the model id, so the order is the same on the
// live pass and on its replay.

import type { ModelInfo } from "./brief.ts";

export type Need = { tools: boolean; vision: boolean; json: boolean };

function meets(model: ModelInfo, need: Need): boolean {
  if (need.tools && !model.tools) return false;
  if (need.vision && !model.vision) return false;
  if (need.json && !model.json) return false;
  return true;
}

export function rankModels(models: ModelInfo[], need: Need): ModelInfo[] {
  return models
    .filter((m) => meets(m, need))
    .sort((a, b) => {
      if (b.rating_milli !== a.rating_milli) return b.rating_milli - a.rating_milli;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
}

export function pickModel(models: ModelInfo[], need: Need, alreadyTried: Set<string>): ModelInfo | null {
  for (const model of rankModels(models, need)) {
    if (!alreadyTried.has(model.id)) return model;
  }
  return null;
}
