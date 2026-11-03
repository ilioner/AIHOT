// Model choices must support the step's protocol and any required image input.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { modelsOverview, switchModel } from "@aihot/backend/admin/models";
import { CAPABILITIES, capabilityAcceptsModel, fallbackModelFor, invalidateModelCache, modelFor, modelSources, type Capability } from "@aihot/backend/editorial/models";
import { MODELS } from "@aihot/backend/providers/llm";

after(closeDb);

test("chat models that read images remain usable for every step; text models cannot serve a step that needs images", async (t) => {
  t.after(async () => {
    await sql`DELETE FROM settings WHERE key = 'models.understand'`;
    invalidateModelCache();
  });
  const understand = CAPABILITIES.understand;
  assert.equal(capabilityAcceptsModel(understand, MODELS["glm-5.3-flash"]!), true);
  assert.equal(capabilityAcceptsModel(understand, MODELS["qwen3-vl-flash"]!), true);
  assert.equal(capabilityAcceptsModel(understand, MODELS["deepseek-flash"]!), true);
  for (const c of Object.values(CAPABILITIES)) assert.equal(capabilityAcceptsModel(c, MODELS["qwen3-vl-flash"]!), true);
  assert.equal(capabilityAcceptsModel({ ...understand, vision: true }, MODELS["deepseek-flash"]!), false);

  await switchModel("understand", "qwen3-vl-flash", "vision routing test", "test");
  assert.equal(await modelFor("understand"), "qwen3-vl-flash");
  await switchModel("understand", "deepseek-flash", "text routing test", "test");
  assert.equal(await modelFor("understand"), "deepseek-flash");

  const overview = await modelsOverview(1);
  assert.equal(overview.capabilities.find((capability) => capability.key === "understand")?.vision, false);
  const vision = overview.choices.find((model) => model.key === "qwen3-vl-flash")!;
  assert.equal(vision.vision, true);
  assert.deepEqual(vision.compatibleCapabilities, overview.capabilities.map((c) => c.key));
  const text = overview.choices.find((model) => model.key === "deepseek-flash")!;
  assert.equal(text.vision, false);
  assert.ok(["understand", "summarize", "translate"].every((key) => text.compatibleCapabilities.includes(key)));
});

test("systemone is selectable only for prefilter and score, including the admin's compatible choices", async (t) => {
  t.after(async () => {
    await sql`DELETE FROM settings WHERE key IN ('models.prefilter', 'models.score')`;
    invalidateModelCache();
  });
  const decision = MODELS["decision-model-preview"]!;
  for (const [key, c] of Object.entries(CAPABILITIES)) {
    assert.equal(capabilityAcceptsModel(c, decision), key === "prefilter" || key === "score", key);
  }
  assert.equal(capabilityAcceptsModel({ ...CAPABILITIES.prefilter, vision: true }, decision), false);

  for (const key of ["prefilter", "score"] as const) {
    await switchModel(key, decision.key, "decision routing test", "test");
    assert.equal(await modelFor(key), decision.key);
  }
  const sources = await modelSources();
  assert.deepEqual(sources.prefilter, { model: decision.key, source: "admin" });
  assert.deepEqual(sources.score, { model: decision.key, source: "admin" });
  const overview = await modelsOverview(1);
  assert.deepEqual(overview.choices.find((model) => model.key === decision.key)?.compatibleCapabilities, ["prefilter", "score"]);
});

test("admin switches reject systemone for writing, translation and other generative steps", async () => {
  for (const key of Object.keys(CAPABILITIES)) {
    if (key === "prefilter" || key === "score") continue;
    const before = await modelFor(key);
    await assert.rejects(switchModel(key, "decision-model-preview", "invalid decision routing", "test"), {
      statusCode: 400, message: /systemone requires a decision step/,
    });
    assert.equal(await modelFor(key), before, "a rejected switch does not change the route");
  }
});

test("environment choices reject an incompatible registered model but preserve the unknown-name fallback", async () => {
  for (const key of ["understand", "summarize", "translate"] as const) {
    const c = CAPABILITIES[key];
    const previous = process.env[c.env];
    try {
      process.env[c.env] = "decision-model-preview";
      const error = new RegExp(`Model decision-model-preview cannot be used for ${key}: systemone`);
      await assert.rejects(modelFor(key), error);
      await assert.rejects(modelSources(), error);

      process.env[c.env] = "unregistered-model";
      assert.equal(await modelFor(key), c.default);
      assert.deepEqual((await modelSources())[key], { model: c.default, source: "default" });
    } finally {
      if (previous === undefined) delete process.env[c.env];
      else process.env[c.env] = previous;
    }
  }
});

test("an incompatible persisted admin choice cannot bypass the step's protocol", async (t) => {
  t.after(async () => {
    await sql`DELETE FROM settings WHERE key = 'models.translate'`;
    invalidateModelCache();
  });
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('models.translate', ${sql.json({ model: "decision-model-preview" })}, 'test')`;
  invalidateModelCache();
  await assert.rejects(modelFor("translate"), /Model decision-model-preview cannot be used for translate: systemone/);
  await assert.rejects(modelSources(), /Model decision-model-preview cannot be used for translate: systemone/);
});

test("fallback pairs skip models with an incompatible protocol or missing required vision", (t) => {
  const primary = "deepseek-flash";
  const pairs = { score: primary, understand: primary, summarize: primary, translate: primary };
  MODELS["test-decision-backup"] = { ...MODELS["decision-model-preview"]!, key: "test-decision-backup", fallbackFor: pairs };
  MODELS["test-text-backup"] = { ...MODELS["qwen3.8-flash"]!, key: "test-text-backup", fallbackFor: pairs };
  MODELS["test-vision-backup"] = { ...MODELS["glm-5.3-flash"]!, key: "test-vision-backup", fallbackFor: pairs };
  const understand = CAPABILITIES.understand as Capability;
  const previous = understand.vision;
  t.after(() => {
    delete MODELS["test-decision-backup"];
    delete MODELS["test-text-backup"];
    delete MODELS["test-vision-backup"];
    if (previous === undefined) delete understand.vision;
    else understand.vision = previous;
  });

  assert.equal(fallbackModelFor("score", primary), "test-decision-backup");
  assert.equal(fallbackModelFor("summarize", primary), "test-text-backup");
  assert.equal(fallbackModelFor("translate", primary), "test-text-backup");
  assert.equal(fallbackModelFor("understand", primary), "test-text-backup");
  understand.vision = true;
  assert.equal(fallbackModelFor("understand", primary), "test-vision-backup");
});
