// System One choice decisions, through the same receipts and budgets as chat calls.
import type { z } from "zod";
import { config, credential } from "../config.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { isConnectFailure, MODELS, type ChatJsonResult } from "./llm.ts";
import { assertAccepted, ModelOutputError, ModelUnavailableError, paidRequest, ProviderRejectedError, rejectReceivedResponse } from "./receipts.ts";

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

interface DecisionOptions<S extends z.ZodType> {
  model: string;
  purpose: string;
  subject: string;
  promptVersion: string;
  state: string | Record<string, unknown>;
  questions: Record<string, ChoiceQuestion>;
  schema: S;
  parse: (choices: Record<string, string>) => unknown;
  attemptTag?: string;
  timeoutMs?: number;
}

export async function choiceDecision<S extends z.ZodType>(opts: DecisionOptions<S>): Promise<ChatJsonResult<z.infer<S>>> {
  const spec = MODELS[opts.model];
  if (!spec) throw new Error(`Unknown model ${opts.model}`);
  if (spec.protocol !== "systemone") throw new ModelUnavailableError(`Model ${opts.model} does not support System One`);
  if (!config.modelCallsEnabled) throw new ModelUnavailableError("Model calls are disabled (MODEL_CALLS_ENABLED=false)");
  const baseUrl = credential("models", spec.baseUrlEnv);
  const apiKey = credential("models", spec.apiKeyEnv);
  if (!baseUrl || !apiKey || !spec.model) throw new ModelUnavailableError(`Model ${opts.model} is not configured (${spec.baseUrlEnv}, ${spec.apiKeyEnv})`);
  const endpoint = `${baseUrl.replace(/\/$/, "")}/systemone`;
  const questionIds = Object.keys(opts.questions);
  if (!questionIds.length || questionIds.length > 16) throw new Error("System One needs 1–16 questions");
  for (const id of questionIds) {
    const question = opts.questions[id]!;
    const choices = Object.entries(question.criteria);
    if (question.type !== "choice" || !question.instructions || !choices.length || choices.length > 255 || choices.some(([key, description]) => !key || !description)) {
      throw new Error(`Invalid System One choice question: ${id}`);
    }
  }
  const stateText = typeof opts.state === "string" ? opts.state : stableJson(opts.state);
  const stateHash = sha256(stateText);
  const questionsHash = sha256(stableJson(opts.questions));
  const endpointHash = sha256(endpoint);
  const receipt = await paidRequest({
    service: spec.service, model: spec.model, purpose: opts.purpose, subject: opts.subject,
    identity: { protocol: "systemone", endpointHash, model: spec.model, promptVersion: opts.promptVersion, stateHash, questionsHash },
    requestSummary: { protocol: "systemone", promptVersion: opts.promptVersion, endpointHash, stateHash, stateChars: stateText.length, questionsHash, questionIds },
    attemptTag: opts.attemptTag,
  }, async () => {
    const started = performance.now();
    let res: Response;
    let text: string;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: spec.model, state: opts.state, questions: opts.questions }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });
      text = await res.text();
      assertAccepted(spec.service, res.status, text);
    } catch (error) {
      if (isConnectFailure(error)) throw new ProviderRejectedError(`connect failed: ${String(error)}`, null, true);
      throw error;
    }
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text);
      if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Expected a response object");
    } catch {
      json = { unparsable: text.slice(0, 20000) };
    }
    const nativeUsage = json.usage && typeof json.usage === "object" && !Array.isArray(json.usage) ? json.usage as Record<string, unknown> : null;
    const inputTokens = nativeUsage?.input_tokens;
    const usage = nativeUsage ? { ...nativeUsage, ...(typeof inputTokens === "number" && Number.isSafeInteger(inputTokens) && inputTokens >= 0 ? { prompt_tokens: inputTokens } : {}) } : null;
    return {
      response: { ...json, _latencyMs: Math.round(performance.now() - started) },
      requestId: typeof json.request_id === "string" ? json.request_id : res.headers.get("x-request-id"),
      usage,
      cost: null,
    };
  });

  const response = receipt.response as { answers?: Record<string, { type?: string; choice?: string }>; usage?: Record<string, unknown> };
  let parsed: z.infer<S>;
  try {
    const answers = response.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers) || Object.keys(answers).length !== questionIds.length) throw new Error("Expected exactly the requested answers");
    const choices: Record<string, string> = {};
    for (const id of questionIds) {
      const answer = answers[id];
      if (answer?.type !== "choice" || typeof answer.choice !== "string" || !Object.hasOwn(opts.questions[id]!.criteria, answer.choice)) throw new Error(`Invalid choice answer: ${id}`);
      choices[id] = answer.choice;
    }
    parsed = opts.schema.parse(opts.parse(choices));
  } catch (error) {
    await rejectReceivedResponse(receipt.receiptId, `unusable output: ${String(error).slice(0, 500)}`);
    throw new ModelOutputError(`Model ${opts.model} returned unusable output for ${opts.subject}: ${String(error).slice(0, 300)}`, receipt.receiptId);
  }
  return { data: parsed, receiptId: receipt.receiptId, reused: receipt.reused, model: spec.key, usage: response.usage ?? null };
}
