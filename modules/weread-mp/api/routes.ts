// The admin's WeRead routes. Every one is behind the engine's /api/admin guard (session + CSRF);
// nothing here returns a token, and no route is reachable from the public site.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { adminHandler, type AdminHandler } from "@aihot/api/routes/admin-auth";
import { createSource } from "@aihot/backend/admin/sources";
import { actorOf } from "@aihot/backend/admin/auth";
import { bookInfo, isLinkOrBiz, resolveBookId, searchAccounts } from "../backend/accounts.ts";
import { listManagedSources } from "../backend/collect.ts";
import { WereadError } from "../backend/http.ts";
import { pollLogin, startLogin } from "../backend/login.ts";
import { accountRow, activateSession, deleteAccount, listAccounts, refreshAccount } from "../backend/pool.ts";
import { isWereadBookId } from "../backend/wechat.ts";

const badRequest = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

/** A WeRead refusal reaches the admin as the explanation the person can act on, not as an internal error. */
const handler = (fn: AdminHandler) => adminHandler(async (req, reply, admin) => {
  try {
    return await fn(req, reply, admin);
  } catch (error) {
    if (error instanceof WereadError) throw badRequest(error.message);
    throw error;
  }
});

const SearchBody = z.object({ keyword: z.string().trim().min(1).max(500) });
const AddBody = z.object({
  bookId: z.string().trim().min(1).max(120),
  nickname: z.string().trim().min(1).max(200),
});
const IdParams = z.object({ id: z.coerce.number().int().positive() });

export function registerWereadRoutes(app: FastifyInstance): void {
  app.get("/api/admin/weread/accounts", handler(async () => ({ accounts: await listAccounts() })));

  app.delete("/api/admin/weread/accounts/:id", handler(async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    if (!(await deleteAccount(id))) return reply.code(404).send({ detail: "这个账号已经不存在" });
    return { ok: true };
  }));

  app.post("/api/admin/weread/accounts/:id/refresh", handler(async (req) => {
    const { id } = IdParams.parse(req.params);
    const row = await accountRow(id);
    if (!row) throw badRequest("这个账号已经不存在");
    const session = await refreshAccount(row);
    if (!session) throw badRequest("刷新登录凭据失败，请重新扫码登录");
    await activateSession(session);
    return { ok: true, vid: session.vid };
  }));

  app.post("/api/admin/weread/login", handler(async () => startLogin()));

  app.get("/api/admin/weread/login/:id", handler(async (req) => {
    const id = String((req.params as Record<string, string>).id ?? "");
    return pollLogin(id);
  }));

  app.post("/api/admin/weread/search", handler(async (req) => {
    const { keyword } = SearchBody.parse(req.body ?? {});
    if (isLinkOrBiz(keyword)) {
      const bookId = await resolveBookId(keyword);
      if (!bookId) throw badRequest("未能从这条链接解析出公众号，请改用公众号名称搜索");
      const info = await bookInfo(bookId).catch(() => null);
      return { results: [{ bookId, nickname: info?.nickname ?? "微信公众号", cover: info?.cover ?? "", intro: info?.intro ?? "" }] };
    }
    return { results: await searchAccounts(keyword) };
  }));

  app.get("/api/admin/weread/sources", handler(async () => ({ sources: await listManagedSources() })));

  app.post("/api/admin/weread/sources", handler(async (req, _reply, admin) => {
    const { bookId, nickname } = AddBody.parse(req.body ?? {});
    if (!isWereadBookId(bookId)) throw badRequest("公众号标识无效，请重新搜索");
    const uin = bookId.slice("MP_WXS_".length);
    return createSource({
      id: `mp-${uin}`,
      name: nickname,
      kind: "mp_account",
      config: { ghid: bookId, nickname },
      interval_minutes: 60,
    }, actorOf(admin));
  }));
}
