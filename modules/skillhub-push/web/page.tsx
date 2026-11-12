import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useAdminAction } from "@aihot/web/features/admin/action";
import { ago, bj, num } from "@aihot/web/features/admin/format";
import { toast } from "@aihot/web/features/admin/toast";
import { AdminPage, Badge, Button, Card, DataTable, Field, Input, ReasonDialog, Select, Stat, Textarea, Time } from "@aihot/web/features/admin/ui";
import { Pagination } from "@aihot/web/features/feed/DayList";

export const meta = () => [{ title: "skillhub 推送 · 后台" }];

interface Overview {
  enabled: boolean;
  baseUrl: string;
  configured: { cookie: boolean; xsrf: boolean; source: "settings" | "environment" | "none" };
  counts: {
    candidates: number;
    pending: number;
    sent: number;
    exists: number;
    failed: number;
    skipped: number;
    /** How many articles the model (or the rules, when it failed) has classified, and by whom. */
    classified: number;
    byModel: number;
    byRules: number;
    unclassified: number;
    /** A classification batch is running right now. */
    classifying: boolean;
  };
  /** The model the step `skillhub-classify` is on now (null when the step cannot be routed). */
  model: string | null;
}

interface PushPage {
  rows: PushRow[];
  page: number;
  pageSize: number;
  total: number;
}

type RepushScope = { articleIds: string[] } | { all: true };

interface PushRow {
  articleId: string;
  eventId?: number;
  operation?: "create" | "update" | "legacy";
  canRepush: boolean;
  title: string;
  status: "pending" | "sent" | "exists" | "failed" | "skipped";
  attempts: number;
  remoteId: number | null;
  lastError: string | null;
  pushedAt: string | null;
  updatedAt: string;
  types: { categoryCode: string; audienceCode: string; featureCode: string | null; decidedBy: "model" | "rules"; model: string | null } | null;
}

const STATUS: Record<PushRow["status"], { label: string; tone: "ok" | "warn" | "bad" | "muted" | "accent" }> = {
  pending: { label: "待推送", tone: "warn" },
  sent: { label: "已推送", tone: "ok" },
  exists: { label: "已存在", tone: "ok" },
  failed: { label: "失败", tone: "bad" },
  skipped: { label: "跳过", tone: "muted" },
};

const OPERATION = { create: "创建", update: "更新", legacy: "旧记录" };
const rowKey = (row: PushRow) => row.eventId ?? row.articleId;

async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" }, signal });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error((detail as { detail?: string } | null)?.detail ?? `请求失败（${res.status}）`);
  }
  return (await res.json()) as T;
}

export default function SkillhubAdmin() {
  const { run, pending } = useAdminAction();
  const [params, setParams] = useSearchParams();
  const requestedPage = Number(params.get("page") ?? 1);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const requestedSize = Number(params.get("pageSize") ?? 20);
  const pageSize = Number.isInteger(requestedSize) && requestedSize > 0 ? Math.min(100, requestedSize) : 20;
  const date = params.get("date") ?? "";
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize), ...(date ? { date } : {}) }).toString();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshIndex, setRefreshIndex] = useState(0);
  const listKey = `${refreshIndex}:${query}`;
  const [items, setItems] = useState<{ key: string; data: PushPage | null; error?: string } | null>(null);
  const [selected, setSelected] = useState(new Set<string | number>());
  const [paste, setPaste] = useState("");
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const [confirmRepush, setConfirmRepush] = useState<RepushScope | null>(null);

  const refresh = useCallback(() => {
    setSelected(new Set());
    setRefreshIndex((index) => index + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void getJson<Overview>("/api/admin/skillhub/overview", controller.signal)
      .then((data) => { if (!controller.signal.aborted) setOverview(data); })
      .catch((error) => {
        if (!controller.signal.aborted) toast(String(error instanceof Error ? error.message : error), "error");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refreshIndex]);

  useEffect(() => {
    const controller = new AbortController();
    void getJson<PushPage>(`/api/admin/skillhub/items?${query}`, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setItems({ key: listKey, data }); })
      .catch((error) => {
        if (controller.signal.aborted) return;
        const message = String(error instanceof Error ? error.message : error);
        setItems({ key: listKey, data: null, error: message });
        toast(message, "error");
      });
    return () => controller.abort();
  }, [query, listKey]);

  useEffect(() => {
    setSelected(new Set());
    setConfirmRepush(null);
  }, [query]);

  const changeFilter = (key: "date" | "pageSize", value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page");
    setParams(next, { preventScrollReset: true });
  };
  const pageHref = (nextPage: number) => {
    const next = new URLSearchParams(params);
    next.set("page", String(nextPage));
    return `?${next}`;
  };

  // One click: parse whatever was pasted, save it sealed, and read the dictionaries back to prove it works.
  const save = async () => {
    setSelected(new Set());
    const done = await run<{
      configured: Overview["configured"];
      parsed: { notes: string[] };
      tested: { ok: boolean; message: string } | null;
    }>("POST", "/api/admin/skillhub/paste", { paste, test: true }, { revalidate: false });
    if (!done) return;
    setPaste("");
    const found = done.parsed.notes.filter((note) => /^(Cookie 取自|Cookie 按|XSRF 取自)/.test(note));
    if (done.tested?.ok) toast(`已保存，连接测试通过：${found.join("；")}`, "ok");
    else if (done.tested) toast(`已保存，但连接测试没通过：${done.tested.message}`, "error");
    else toast("已保存；登录态加密存放，页面上不再显示", "ok");
    void refresh();
  };

  const test = async () => {
    setSelected(new Set());
    const done = await run<{ ok: boolean; message: string; dictionaries?: Record<string, number> }>(
      "POST",
      "/api/admin/skillhub/test",
      {},
      { revalidate: false },
    );
    if (!done) return;
    if (done.ok) {
      const counts = done.dictionaries ? `分类 ${done.dictionaries.category} 项、适用人群 ${done.dictionaries.audience} 项、功能特点 ${done.dictionaries.feature} 项` : "";
      toast(`${done.message}${counts ? `（${counts}）` : ""}`, "ok");
    } else {
      toast(done.message, "error");
    }
  };

  const pushAll = async () => {
    setSelected(new Set());
    const done = await run<{ enqueued: number; pending: number }>(
      "POST",
      "/api/admin/skillhub/run",
      {},
      {
        success: (result) =>
          result.enqueued ? `已排队，本批最多 ${result.pending} 条待推送工具` : "已有推送任务在排队或正在跑，稍等它跑完",
        revalidate: false,
      },
    );
    if (done) void refresh();
  };

  const retryFailed = async () => {
    setSelected(new Set());
    const done = await run<{ reset: number; enqueued: number }>(
      "POST",
      "/api/admin/skillhub/retry-failed",
      {},
      { success: (result) => (result.reset ? `已重新排队 ${result.reset} 条失败记录` : "没有失败的记录"), revalidate: false },
    );
    if (done) void refresh();
  };

  const retryOne = async (row: PushRow) => {
    setSelected(new Set());
    const done = await run("POST", `/api/admin/skillhub/items/${encodeURIComponent(row.articleId)}/retry`, undefined, { revalidate: false });
    if (done) {
      toast("已重新排队这一条", "ok");
      void refresh();
    }
  };

  // Fills in the codes the model has not decided yet; a model that fails leaves the keyword rules in place.
  const reclassify = async () => {
    setSelected(new Set());
    const done = await run<{ attempted: number; byModel: number; byRules: number; model: string | null }>(
      "POST",
      "/api/admin/skillhub/classify",
      { onlyMissing: true, limit: 100 },
      { revalidate: false },
    );
    if (!done) return;
    toast(
      done.attempted === 0
        ? "没有还需要分类的条目"
        : `已分类 ${done.attempted} 条：模型 ${done.byModel} 条${done.byRules ? `，退回规则 ${done.byRules} 条` : ""}${done.model ? `（${done.model}）` : ""}`,
      done.byRules > 0 ? "info" : "ok",
    );
    void refresh();
  };

  // Re-sends every tool already in skillhub in full, with the model's codes: the only way to fix the
  // types of the 282 tools that were pushed before the model decided them.
  const updateExisting = async () => {
    setSelected(new Set());
    const done = await run<{ enqueued: number; sent: number }>(
      "POST",
      "/api/admin/skillhub/run",
      { updateExisting: true, reclassify: true },
      {
        success: (result) => (result.enqueued ? `已排队：将用模型分类结果更新 ${result.sent} 条远端工具的完整内容` : "已有更新任务在排队或正在跑，稍等它跑完"),
        revalidate: false,
      },
    );
    setConfirmUpdate(false);
    if (done) void refresh();
  };

  const repush = async () => {
    if (!confirmRepush || pending) return false;
    setSelected(new Set());
    const scope = "all" in confirmRepush ? "all" : [...confirmRepush.articleIds].sort().join(",");
    const done = await run<{ enqueued: number; pending: number }>(
      "POST",
      "/api/admin/skillhub/repush",
      confirmRepush,
      {
        label: `POST /api/admin/skillhub/repush ${scope}`,
        success: (result) => result.enqueued
          ? `已排队重新创建 ${num(result.pending)} 条工具；请稍后刷新查看结果`
          : result.pending > 0 ? `已有任务在排队或执行，当前待推送 ${num(result.pending)} 条` : "没有可重新创建的候选",
        revalidate: false,
      },
    );
    if (!done) return false;
    refresh();
    return true;
  };

  const counts = overview?.counts;
  const configured = overview?.configured;
  const currentItems = items?.key === listKey ? items : null;
  const itemsLoading = !currentItems;
  const rows = currentItems?.data?.rows ?? [];
  const total = currentItems?.data?.total ?? 0;
  const currentPage = currentItems?.data?.page ?? page;
  const pageCount = Math.max(1, Math.ceil(total / (currentItems?.data?.pageSize ?? pageSize)));
  const selectable = rows.filter((row) => row.canRepush);
  const pageSelected = selectable.length > 0 && selectable.every((row) => selected.has(rowKey(row)));
  const selectedRows = selectable.filter((row) => selected.has(rowKey(row)));
  const selectedArticleIds = [...new Set(selectedRows.map((row) => row.articleId))];
  const repushing = pending?.startsWith("POST /api/admin/skillhub/repush ") ?? false;

  return (
    <AdminPage
      title="skillhub 推送"
      subtitle="把已公开的 AI 工具目录条目推送到 skillhub 后台（创建接口 POST /api/v1/admin/ai-tools）。推送失败会跳过并记下原因，不影响后面的条目；登录态加密存放，页面上不会显示。"
    >
      <div className="grid gap-5 xl:grid-cols-2">
        <Card
          title="连接配置"
          right={
            configured ? (
              <Badge tone={configured.cookie && configured.xsrf ? "ok" : "warn"}>
                {configured.cookie && configured.xsrf ? (configured.source === "environment" ? "已配置（环境变量）" : "已配置") : "未配置完整"}
              </Badge>
            ) : undefined
          }
        >
          <div className="flex flex-col gap-3">
            <Field
              label="登录凭据"
              hint="在 skillhub 后台按 F12 → 网络（Network）→ 右键任意请求 → Copy as cURL，整条粘进来就行；也可以只粘 Cookie 头的值，XSRF 会自动从 Cookie 里的 XSRF-TOKEN 取。保存后不再显示。"
            >
              <Textarea
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                placeholder={
                  configured?.cookie
                    ? "已保存。要换一个登录态，就把新的 curl 粘进来。"
                    : "curl 'https://skillhub.aefree.com/api/v1/admin/...' -H 'cookie: …' -H 'x-xsrf-token: …'"
                }
                rows={5}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                tone="primary"
                busy={pending === "POST /api/admin/skillhub/paste"}
                disabled={!!pending || !paste.trim()}
                onClick={() => void save()}
              >
                解析并保存
              </Button>
              <Button tone="secondary" busy={pending === "POST /api/admin/skillhub/test"} disabled={!!pending} onClick={() => void test()}>
                测试连接
              </Button>
            </div>
            <p className="text-[12px] leading-relaxed text-ink-4">
              接口地址：{overview?.baseUrl ?? "https://skillhub.aefree.com"}。自动推送每天扫一次（默认 09:00，SKILLHUB_PUSH_CRON
              可改），只有环境变量 SKILLHUB_PUSH_ENABLED=true 时才开启；页面上的按钮随时可用。
            </p>
          </div>
        </Card>

        <Card
          title="推送概览"
          right={<Button size="sm" tone="ghost" disabled={!!pending || loading || itemsLoading} onClick={refresh}>刷新</Button>}
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="工具总数" value={loading ? "…" : num(counts?.candidates)} hint="已公开的工具目录与政策条目" />
            <Stat label="待推送" value={loading ? "…" : num(counts?.pending)} tone={counts && counts.pending > 0 ? "warn" : undefined} />
            <Stat label="已推送" value={loading ? "…" : num(counts?.sent)} tone="ok" />
            <Stat label="已存在" value={loading ? "…" : num(counts?.exists)} hint="skillhub 里已有同 slug/地址" />
            <Stat label="失败" value={loading ? "…" : num(counts?.failed)} tone={counts && counts.failed > 0 ? "bad" : undefined} />
            <Stat label="跳过" value={loading ? "…" : num(counts?.skipped)} hint="标题或地址不可推送" />
            <Stat
              label="已分类"
              value={loading ? "…" : `${num(counts?.classified)}/${num(counts?.candidates)}`}
              tone={counts && counts.unclassified > 0 ? "warn" : "ok"}
              hint={
                counts
                  ? `${counts.classifying ? "分类中…，" : ""}模型 ${num(counts.byModel)} 条，规则 ${num(counts.byRules)} 条，未分类 ${num(counts.unclassified)} 条`
                  : undefined
              }
            />
            <Stat label="分类模型" value={<span className="text-[13px]">{overview?.model ?? "—"}</span>} hint="默认用 .env 的 LLM_MODEL，后台「模型与评测」可换" />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              tone="primary"
              busy={pending === "POST /api/admin/skillhub/run"}
              disabled={!!pending || !counts || counts.pending === 0}
              onClick={() => void pushAll()}
            >
              推送全部待推送
            </Button>
            <Button
              tone="secondary"
              busy={pending === "POST /api/admin/skillhub/retry-failed"}
              disabled={!!pending || !counts || counts.failed === 0}
              onClick={() => void retryFailed()}
            >
              重试失败
            </Button>
            <Button
              tone="secondary"
              busy={pending === "POST /api/admin/skillhub/classify"}
              disabled={!!pending || !counts || counts.unclassified === 0}
              onClick={() => void reclassify()}
            >
              用模型重新分类
            </Button>
            <Button
              tone="secondary"
              busy={pending === "POST /api/admin/skillhub/run"}
              disabled={!!pending || !counts || counts.sent === 0}
              onClick={() => setConfirmUpdate(true)}
            >
              用模型重分类并更新远端
            </Button>
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-ink-4">
            自动推送：{overview?.enabled ? "已开启（每天扫一次，默认 09:00，可用 SKILLHUB_PUSH_CRON 改时间）" : "未开启（SKILLHUB_PUSH_ENABLED 不是 true）"}。
            推过的条目（已推送/已存在）不会自动重推；每条最多自动重试 3 次，之后停在「失败」。可手动重试失败，或在下方确认「重新创建」补回远端已删除的记录；重新创建不会覆盖远端已有字段。
          </p>
        </Card>
      </div>

      <ReasonDialog
        open={confirmUpdate}
        title="用模型重新分类并更新远端"
        description={`会把 skillhub 里已有的 ${num(counts?.sent)} 条工具整体重新提交一遍（PUT 完整内容，名称、地址、分类都会覆盖成当前的模型判断）。已推送的条目不会被重新创建，但已经在 skillhub 里手工改过的字段会被覆盖。`}
        confirmLabel="开始更新"
        requireReason={false}
        busy={pending === "POST /api/admin/skillhub/run"}
        onClose={() => setConfirmUpdate(false)}
        onSubmit={() => void updateExisting()}
      />

      <ReasonDialog
        open={confirmRepush !== null}
        title={confirmRepush && "all" in confirmRepush ? "重新创建全部当前候选" : "重新创建已选工具"}
        description={
          <>
            <p>
              {confirmRepush && "all" in confirmRepush
                ? `将重新提交全部当前已公开且符合推送条件的候选（概览当前为 ${num(counts?.candidates)} 条，以执行时资格为准），不受日期筛选、当前页或勾选范围限制。`
                : `将重新提交已选的 ${num(confirmRepush && "articleIds" in confirmRepush ? confirmRepush.articleIds.length : 0)} 条工具；同一工具的多条历史记录只提交一次。`}
            </p>
            <p className="mt-2">
              仅调用创建接口 POST，复用已缓存的分类，不使用 PUT。远端已有同 slug 或地址的记录会标记为「已存在（exists）」；
              远端已删除的记录会重新创建。不会覆盖远端已有的名称、地址、分类等字段，也不会改写历史推送记录。
            </p>
          </>
        }
        confirmLabel="确认重新创建"
        requireReason={false}
        busy={repushing}
        onClose={() => { if (!repushing) setConfirmRepush(null); }}
        onSubmit={repush}
      />

      <div className="mt-5">
        <Card title={date ? "按日推送历史" : "当前推送记录"} right={<Badge tone="muted">{itemsLoading ? "读取中…" : currentItems?.error ? "读取失败" : `共 ${num(total)} 条`}</Badge>}>
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <Field label="推送日期（北京时间 UTC+08）">
              <Input type="date" aria-label="推送日期（北京时间 UTC+08）" value={date} disabled={!!pending} onChange={(event) => changeFilter("date", event.target.value)} />
            </Field>
            <Button tone="ghost" disabled={!date || !!pending} onClick={() => changeFilter("date", "")}>清除日期</Button>
            <Field label="每页条数">
              <Select aria-label="每页条数" value={pageSize} disabled={!!pending} onChange={(event) => changeFilter("pageSize", event.target.value)}>
                {[...new Set([20, 50, 100, pageSize])].sort((a, b) => a - b).map((size) => <option key={size} value={size}>{size} 条</option>)}
              </Select>
            </Field>
          </div>
          <p className="mb-3 text-[12px] leading-relaxed text-ink-4">
            {date
              ? "按北京时间（UTC+08）00:00 至次日 00:00 查看当天不可改写的推送尝试历史；同一工具可能出现多次，操作针对其当前版本。"
              : "未选日期时展示各条目的当前状态；选择日期后查看当天的推送尝试历史，不是文章发布日期。"}
            概览统计不受日期筛选影响。不能勾选的条目当前已不符合推送条件。
          </p>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
            <span aria-live="polite">已勾选 {num(selectedRows.length)} 条记录（{num(selectedArticleIds.length)} 条工具）</span>
            <Button size="sm" tone="ghost" disabled={!selectedRows.length || !!pending} onClick={() => setSelected(new Set())}>清除选择</Button>
            <Button
              tone="primary"
              busy={repushing && !!confirmRepush && "articleIds" in confirmRepush}
              disabled={!!pending || !selectedArticleIds.length}
              onClick={() => setConfirmRepush({ articleIds: selectedArticleIds })}
            >
              重新创建已选工具
            </Button>
            <Button
              tone="secondary"
              busy={repushing && !!confirmRepush && "all" in confirmRepush}
              disabled={!!pending || !counts || counts.candidates === 0}
              onClick={() => setConfirmRepush({ all: true })}
            >
              重新创建全部当前候选
            </Button>
            <span className="w-full">「全部当前候选」覆盖所有页，不受日期筛选影响；与上方覆盖远端字段的「用模型重分类并更新远端」是不同操作。</span>
          </div>
          <DataTable
            rows={rows}
            rowKey={rowKey}
            empty={itemsLoading ? "读取中…" : currentItems?.error ? `读取失败：${currentItems.error}。请点击概览中的「刷新」重试。` : date ? "当天没有推送记录。" : "还没有推送记录。先配置凭据，再点「推送全部待推送」。"}
            columns={[
              {
                key: "pick",
                label: <input
                  type="checkbox"
                  className="size-4 accent-[var(--accent)]"
                  aria-label="选择当前页可重新创建的记录"
                  checked={pageSelected}
                  disabled={!selectable.length || !!pending}
                  ref={(node) => { if (node) node.indeterminate = selectedRows.length > 0 && !pageSelected; }}
                  onChange={(event) => setSelected(event.target.checked ? new Set(selectable.map(rowKey)) : new Set())}
                />,
                render: (row) => <input
                  type="checkbox"
                  className="size-4 accent-[var(--accent)]"
                  aria-label={`选择 ${row.title}${row.eventId !== undefined ? `（记录 ${row.eventId}）` : ""}`}
                  title={row.canRepush ? "重新创建此工具" : "当前已不符合推送条件"}
                  disabled={!row.canRepush || !!pending}
                  checked={row.canRepush && selected.has(rowKey(row))}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setSelected((previous) => {
                      const next = new Set(previous);
                      if (checked) next.add(rowKey(row));
                      else next.delete(rowKey(row));
                      return next;
                    });
                  }}
                />,
              },
              {
                key: "title",
                label: "工具",
                render: (row) => (
                  <div className="min-w-0 max-w-[420px]">
                    <div className="truncate font-medium text-ink" title={row.title}>{row.title}</div>
                    <div className="truncate text-[11.5px] text-ink-4">{row.articleId}</div>
                  </div>
                ),
              },
              {
                key: "status",
                label: "状态",
                render: (row) => (
                  <div>
                    <Badge tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Badge>
                    {row.operation && <div className="mt-1 text-[11.5px] text-ink-4">{OPERATION[row.operation]}</div>}
                    {row.attempts > 0 && <div className="mt-1 text-[11.5px] text-ink-4">尝试 {row.attempts} 次</div>}
                  </div>
                ),
              },
              {
                key: "types",
                label: "模型分类",
                render: (row) =>
                  row.types ? (
                    <div className="min-w-0 max-w-[220px]">
                      <div className="truncate text-[12px] text-ink" title={`${row.types.categoryCode} / ${row.types.audienceCode} / ${row.types.featureCode ?? "无"}`}>
                        {row.types.categoryCode} · {row.types.audienceCode}
                        {row.types.featureCode ? ` · ${row.types.featureCode}` : ""}
                      </div>
                      <div className="text-[11px] text-ink-4">{row.types.decidedBy === "model" ? row.types.model ?? "模型" : "规则（模型未采用）"}</div>
                    </div>
                  ) : (
                    <span className="text-ink-4">{row.operation === "legacy" ? "旧分类未记录" : "未分类"}</span>
                  ),
              },
              {
                key: "remote",
                label: "skillhub ID",
                align: "right",
                render: (row) => (row.remoteId === null ? <span className="text-ink-4">—</span> : row.remoteId),
              },
              {
                key: "pushed",
                label: date ? "尝试时间（北京时间）" : "推送时间",
                render: (row) => date
                  ? <time dateTime={row.updatedAt} className="num whitespace-nowrap">{bj(row.updatedAt, true)}</time>
                  : <Time at={row.pushedAt} title={row.pushedAt ? bj(row.pushedAt, true) : undefined} />,
              },
              {
                key: "error",
                label: date ? "本次错误" : "最近错误",
                render: (row) =>
                  row.lastError ? (
                    <div className="max-w-[360px] text-[12px] leading-relaxed text-hot" title={row.lastError}>{row.lastError}</div>
                  ) : (
                    <span className="text-ink-4">—</span>
                  ),
              },
              {
                key: "actions",
                label: "",
                align: "right",
                render: (row) => (
                  <div className="flex flex-col items-end gap-1">
                    <Button
                      size="sm"
                      tone="ghost"
                      busy={pending === `POST /api/admin/skillhub/items/${encodeURIComponent(row.articleId)}/retry`}
                      disabled={!!pending || !row.canRepush}
                      title={date ? "重试此工具的当前状态，不改写这条历史记录" : undefined}
                      onClick={() => void retryOne(row)}
                    >
                      重试
                    </Button>
                    <span className="text-[11px] text-ink-4">{ago(row.updatedAt)}{date ? "记录" : "更新"}</span>
                  </div>
                ),
              },
            ]}
          />
          {currentItems?.data && (
            <>
              <p className="mt-4 text-center text-[12px] text-ink-4">共 {num(total)} 条记录 · 第 {num(currentPage)} / {num(pageCount)} 页</p>
              <Pagination page={currentPage} pageCount={pageCount} href={pageHref} />
            </>
          )}
        </Card>
      </div>
    </AdminPage>
  );
}
