import { useCallback, useEffect, useState } from "react";
import { useAdminAction } from "@aihot/web/features/admin/action";
import { ago, bj, num } from "@aihot/web/features/admin/format";
import { toast } from "@aihot/web/features/admin/toast";
import { AdminPage, Badge, Button, Card, DataTable, Field, Input, ReasonDialog, Stat, Textarea, Time } from "@aihot/web/features/admin/ui";

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
  rows: PushRow[];
}

interface PushRow {
  articleId: string;
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

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error((detail as { detail?: string } | null)?.detail ?? `请求失败（${res.status}）`);
  }
  return (await res.json()) as T;
}

export default function SkillhubAdmin() {
  const { run, pending } = useAdminAction();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [paste, setPaste] = useState("");
  const [confirmUpdate, setConfirmUpdate] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setOverview(await getJson<Overview>("/api/admin/skillhub/overview"));
    } catch (error) {
      toast(String(error instanceof Error ? error.message : error), "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // One click: parse whatever was pasted, save it sealed, and read the dictionaries back to prove it works.
  const save = async () => {
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
    const done = await run<{ reset: number; enqueued: number }>(
      "POST",
      "/api/admin/skillhub/retry-failed",
      {},
      { success: (result) => (result.reset ? `已重新排队 ${result.reset} 条失败记录` : "没有失败的记录"), revalidate: false },
    );
    if (done) void refresh();
  };

  const retryOne = async (row: PushRow) => {
    const done = await run("POST", `/api/admin/skillhub/items/${encodeURIComponent(row.articleId)}/retry`, undefined, { revalidate: false });
    if (done) {
      toast("已重新排队这一条", "ok");
      void refresh();
    }
  };

  // Fills in the codes the model has not decided yet; a model that fails leaves the keyword rules in place.
  const reclassify = async () => {
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

  const counts = overview?.counts;
  const configured = overview?.configured;

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
                disabled={!paste.trim()}
                onClick={() => void save()}
              >
                解析并保存
              </Button>
              <Button tone="secondary" busy={pending === "POST /api/admin/skillhub/test"} onClick={() => void test()}>
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
          right={<Button size="sm" tone="ghost" onClick={() => void refresh()}>刷新</Button>}
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
              disabled={!counts || counts.pending === 0}
              onClick={() => void pushAll()}
            >
              推送全部待推送
            </Button>
            <Button
              tone="secondary"
              busy={pending === "POST /api/admin/skillhub/retry-failed"}
              disabled={!counts || counts.failed === 0}
              onClick={() => void retryFailed()}
            >
              重试失败
            </Button>
            <Button
              tone="secondary"
              busy={pending === "POST /api/admin/skillhub/classify"}
              disabled={!counts || counts.unclassified === 0}
              onClick={() => void reclassify()}
            >
              用模型重新分类
            </Button>
            <Button
              tone="secondary"
              busy={pending === "POST /api/admin/skillhub/run"}
              disabled={!counts || counts.sent === 0}
              onClick={() => setConfirmUpdate(true)}
            >
              用模型重分类并更新远端
            </Button>
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-ink-4">
            自动推送：{overview?.enabled ? "已开启（每天扫一次，默认 09:00，可用 SKILLHUB_PUSH_CRON 改时间）" : "未开启（SKILLHUB_PUSH_ENABLED 不是 true）"}。
            推过的条目（已推送/已存在）永不重推；每条最多自动重试 3 次，之后停在「失败」，只有这里点「重试失败」才会再来。
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

      <div className="mt-5">
        <Card title="推送记录" right={<Badge tone="muted">{overview?.rows.length ?? 0} 条</Badge>}>
          <DataTable
            rows={overview?.rows ?? []}
            rowKey={(row) => row.articleId}
            empty={loading ? "读取中…" : "还没有推送记录。先配置凭据，再点「推送全部待推送」。"}
            columns={[
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
                    <span className="text-ink-4">未分类</span>
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
                label: "推送时间",
                render: (row) => <Time at={row.pushedAt} title={row.pushedAt ? bj(row.pushedAt, true) : undefined} />,
              },
              {
                key: "error",
                label: "最近错误",
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
                      busy={pending === `POST /api/admin/skillhub/items/${row.articleId}/retry`}
                      onClick={() => void retryOne(row)}
                    >
                      重试
                    </Button>
                    <span className="text-[11px] text-ink-4">{ago(row.updatedAt)}更新</span>
                  </div>
                ),
              },
            ]}
          />
        </Card>
      </div>
    </AdminPage>
  );
}
