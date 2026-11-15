# Free Model Aggregator (free-model-aggregator-02)

One Node 22 server that aggregates OpenRouter's free models behind a
single endpoint. It answers OpenAI Chat Completions
(`POST /v1/chat/completions`) and Anthropic Messages
(`POST /v1/messages`) in JSON and in streaming, lists the fourteen free
models on `GET /v1/models` (the wire follows the auth header), and dials
every completion through the grader's gateway on Chat Completions.

Model choice is driven by the trial brief: for each prompt the server
serves with the highest-rated free model that meets the prompt's
requirements (tools, vision, JSON mode), and fails over down the same
ranking on a refusal, reporting the trail in
`x-makefun-upstream-failures`. Retried and failed-over calls are reported
there so the failover column can see a refusal the server recovered from.

Run it:

```sh
node main.ts --list   # print the catalog and exit
node main.ts          # serve: registers with $MAKEFUN_ENV_URL, exits 0 when the work is done
```

Standard library only, no dependencies. The catalog comes from the trial
brief at runtime, so `node main.ts --list` prints exactly the document
the server registers, and outside a trial it prints an empty catalog.
