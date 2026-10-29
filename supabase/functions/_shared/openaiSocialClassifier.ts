import { INTENTS, NEXT_ACTIONS, POTENTIALS, ROUTES, type AIProvider } from "./socialClassifier.ts";

const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "commercial_potential", "lead_score", "route_type", "confidence", "reason", "recommended_next_action", "signals", "needs_more_signal"],
  properties: {
    intent: { type: "string", enum: [...INTENTS] },
    commercial_potential: { type: "string", enum: [...POTENTIALS] },
    lead_score: { type: "integer" },
    route_type: { type: "string", enum: [...ROUTES] },
    confidence: { type: "number" },
    reason: { type: "string" },
    recommended_next_action: { type: "string", enum: [...NEXT_ACTIONS] },
    signals: { type: "array", items: { type: "string" } },
    needs_more_signal: { type: "boolean" },
  },
} as const;

export function createOpenAIClassifier(
  apiKey: string,
  model: string,
  fetcher: typeof fetch = fetch,
  options: { reasoningEffort?: string } = {},
): AIProvider {
  if (!apiKey || !model) throw new Error("classifier_provider_not_configured");
  const reasoningEffort = options.reasoningEffort?.trim();
  if (reasoningEffort && !REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error("classifier_reasoning_effort_invalid");
  }
  return async (systemPrompt, contextJson) => {
    const response = await fetcher("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        store: false,
        input: [{ role: "system", content: systemPrompt }, { role: "user", content: contextJson }],
        text: { format: { type: "json_schema", name: "social_classifier_v1", strict: true, schema: outputSchema } },
        max_output_tokens: 400,
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 429) throw new Error("classifier_rate_limited");
    if (!response.ok) throw new Error("classifier_provider_error");
    const result = await response.json();
    if (result?.status !== "completed") throw new Error("classifier_incomplete");
    const text = result.output?.flatMap((item: any) => item?.content ?? [])
      .find((part: any) => part?.type === "output_text")?.text;
    if (typeof text !== "string") throw new Error("classifier_output_missing");
    return text;
  };
}
