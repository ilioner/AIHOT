// The admin's skillhub routes. Every one is behind the engine's /api/admin guard (session + CSRF), and
// none of them returns a Cookie or an XSRF token: the page only learns whether each half is configured.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { adminHandler, type AdminHandler } from "@aihot/api/routes/admin-auth";
import { actorOf } from "@aihot/backend/admin/auth";
import { audit } from "@aihot/backend/audit";
import { baseUrl, clearDictionaryCache, openSkillhub } from "../backend/client.ts";
import { classificationRunning, currentModel, typeCounts } from "../backend/classify.ts";
import { configuration, saveCredentials } from "../backend/credentials.ts";
import { parseSession } from "../backend/paste.ts";
import { classifyOnly, enqueueArticles, enqueueOne, enqueuePending, enqueueUpdate, overviewCounts, pushEnabled, pushStatusCounts, recentPushes, resetFailed, resetOne } from "../backend/push.ts";

const handler = (fn: AdminHandler) => adminHandler(fn);

const RunBody = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  onlyFailed: z.boolean().optional(),
  articleIds: z.array(z.string().trim().min(1).max(80)).max(500).optional(),
  /** PUT the whole body of tools already in skillhub, instead of creating the missing ones. */
  updateExisting: z.boolean().optional(),
  /** Ask the model again instead of reusing the cached codes (used with updateExisting). */
  reclassify: z.boolean().optional(),
});
const ClassifyBody = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  articleIds: z.array(z.string().trim().min(1).max(80)).max(500).optional(),
  onlyMissing: z.boolean().optional(),
});
// One box: a whole curl, a block of request headers, or the bare Cookie value. `test` also runs the
// dictionary read so the admin learns in the same click whether the session works.
const PasteBody = z.object({
  paste: z.string().min(1).max(20_000),
  test: z.boolean().optional(),
});
const ArticleParams = z.object({ articleId: z.string().trim().min(1).max(80) });

export function registerSkillhubRoutes(app: FastifyInstance): void {
  app.get("/api/admin/skillhub/overview", handler(async () => {
    const [counts, statuses, rows, configured, classified, model] = await Promise.all([
      overviewCounts(),
      pushStatusCounts(),
      recentPushes(),
      configuration(),
      typeCounts(),
      currentModel(),
    ]);
    return {
      enabled: pushEnabled(),
      baseUrl: baseUrl(),
      configured,
      // classified/unclassified say how much of the directory the model has looked at; model is the
      // step's current choice (后台「模型与评测」can change it).
      counts: {
        ...statuses,
        ...counts,
        classified: classified.classified,
        byModel: classified.byModel,
        byRules: classified.byRules,
        unclassified: Math.max(0, counts.candidates - classified.classified),
        // True while a classification batch is running in this process (the page shows 分类中…).
        classifying: classificationRunning(),
      },
      model,
      rows,
    };
  }));

  // Queued rather than run inside the request: 300+ tools are minutes of calls, and the worker owns
  // the pacing. The page reads the counts again while the batch runs.
  app.post("/api/admin/skillhub/run", handler(async (req, _reply, admin) => {
    const body = RunBody.parse(req.body ?? {});
    if (body.updateExisting) {
      const queued = await enqueueUpdate({ limit: body.limit, articleIds: body.articleIds, reclassify: body.reclassify ?? true });
      // A full re-send rewrites tools that are already live in skillhub: the trail says who asked and how many.
      await audit(actorOf(admin), "skillhub.update", "skillhub-push", null, null, {
        enqueued: queued.enqueued,
        sent: queued.sent,
        limit: body.limit ?? null,
        reclassify: body.reclassify ?? true,
        articles: body.articleIds?.length ?? 0,
      });
      return { ...queued, mode: "update" as const };
    }
    const queued = body.articleIds?.length
      ? { ...(await enqueueArticles(body.articleIds)), limit: body.limit ?? null }
      : { ...(await enqueuePending(body.limit)), reset: body.onlyFailed ? await resetFailed() : 0, limit: body.limit ?? null };
    // A manual push spends the site's outbound identity: the audit trail says who asked for it.
    await audit(actorOf(admin), "skillhub.push", "skillhub-push", null, null, {
      enqueued: queued.enqueued,
      pending: queued.pending,
      limit: body.limit ?? null,
      onlyFailed: body.onlyFailed ?? false,
      articles: body.articleIds?.length ?? 0,
    });
    return { ...queued, mode: "push" as const };
  }));

  // Runs the classifier now (the sweep only fills in what it needs): the page's「用模型重新分类」.
  app.post("/api/admin/skillhub/classify", handler(async (req, _reply, admin) => {
    const body = ClassifyBody.parse(req.body ?? {});
    const result = await classifyOnly({ limit: body.limit, articleIds: body.articleIds, onlyMissing: body.onlyMissing });
    // Counts and the model's name, never a credential.
    await audit(actorOf(admin), "skillhub.classify", "skillhub-push", null, null, {
      attempted: result.attempted,
      byModel: result.byModel,
      byRules: result.byRules,
      model: result.model,
      onlyMissing: body.onlyMissing ?? false,
    });
    return result;
  }));

  // The card's only input: whatever the admin copied (a whole curl, a block of headers, or a bare Cookie
  // value). The session is pulled out here, saved sealed, and never sent back — the reply says which
  // halves were found and where, plus how a "测试连接" went when asked.
  app.post("/api/admin/skillhub/paste", handler(async (req, reply, admin) => {
    const body = PasteBody.parse(req.body ?? {});
    const parsed = parseSession(body.paste);
    if (!parsed.cookie && !parsed.xsrf) {
      return reply.code(400).send({ detail: "没识别出 Cookie 或 XSRF", notes: parsed.notes });
    }
    const before = await configuration();
    await saveCredentials({ cookie: parsed.cookie ?? undefined, xsrf: parsed.xsrf ?? undefined });
    const after = await configuration();
    clearDictionaryCache();
    const summary = { cookie: Boolean(parsed.cookie), xsrf: Boolean(parsed.xsrf), baseUrl: parsed.baseUrl };
    await audit(actorOf(admin), "skillhub.config", "skillhub.push", null, before, { ...after, parsed: summary });
    let tested: { ok: boolean; message: string } | null = null;
    if (body.test) {
      const opened = await openSkillhub({ fresh: true });
      tested = opened.ok ? { ok: true, message: "连接正常，三本字典都能读到" } : { ok: false, message: opened.error };
    }
    return { configured: after, parsed: { ...summary, notes: parsed.notes }, tested };
  }));

  // Proves the pasted session works: it reads the three dictionaries the create call depends on.
  app.post("/api/admin/skillhub/test", handler(async () => {
    clearDictionaryCache();
    const opened = await openSkillhub({ fresh: true });
    if (!opened.ok) return { ok: false, message: opened.error };
    const { ids } = opened.skillhub;
    return {
      ok: true,
      message: "连接正常，三本字典都能读到",
      dictionaries: { category: ids.category.size, audience: ids.audience.size, feature: ids.feature.size },
    };
  }));

  app.post("/api/admin/skillhub/retry-failed", handler(async (_req, _reply, admin) => {
    const reset = await resetFailed();
    if (reset === 0) return { reset: 0, enqueued: 0, pending: 0 };
    const queued = await enqueuePending();
    await audit(actorOf(admin), "skillhub.retry", "skillhub-push", null, { reset }, queued);
    return { reset, ...queued };
  }));

  app.post("/api/admin/skillhub/items/:articleId/retry", handler(async (req, reply, admin) => {
    const { articleId } = ArticleParams.parse(req.params);
    if (!(await resetOne(articleId))) return reply.code(404).send({ detail: "没有这条工具" });
    await enqueueOne(articleId);
    await audit(actorOf(admin), "skillhub.retry", `content:${articleId}`, null, null, { articleId });
    return { ok: true };
  }));
}
