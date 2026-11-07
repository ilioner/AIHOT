import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { useAdminAction } from "@aihot/web/features/admin/action";
import { ago, bj } from "@aihot/web/features/admin/format";
import { toast } from "@aihot/web/features/admin/toast";
import { AdminPage, Badge, Button, Card, DataTable, Field, Input, Time, healthTone } from "@aihot/web/features/admin/ui";

export const meta = () => [{ title: "微信读书采集 · 后台" }];

interface Account {
  id: number;
  vid: string;
  nickname: string;
  avatar: string;
  status: "active" | "cooling" | "reauth";
  failCount: number;
  cooldownUntil: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
  nextAllowedAt: string | null;
  requestsHour: number;
  hourlyBudget: number;
  cooldownLevel: number;
}

interface Pool {
  total: number;
  ready: number;
  cooling: number;
  reauth: number;
  nextAt: string | null;
  requestsThisHour: number;
  hourlyBudget: number;
  intervalMs: number;
}

interface ManagedSource {
  id: string;
  name: string;
  bookId: string;
  health: string;
  enabled: boolean;
  intervalMinutes: number;
  lastFetchAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  articles: number;
}

interface BookResult {
  bookId: string;
  nickname: string;
  cover: string;
  intro: string;
}

interface Login {
  id: string;
  qr: string;
  status: "scanning" | "scanned" | "success" | "expired" | "failed";
  message: string;
}

const ENDED: Login["status"][] = ["success", "expired", "failed"];

const STATUS: Record<Account["status"], { label: string; tone: "ok" | "warn" | "bad" | "muted" }> = {
  active: { label: "可用", tone: "ok" },
  cooling: { label: "冷却中", tone: "warn" },
  reauth: { label: "需重新扫码", tone: "bad" },
};

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error((detail as { detail?: string } | null)?.detail ?? `请求失败（${res.status}）`);
  }
  return (await res.json()) as T;
}

export default function WereadAdmin() {
  const { run, pending } = useAdminAction();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [pool, setPool] = useState<Pool | null>(null);
  const [sources, setSources] = useState<ManagedSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [login, setLogin] = useState<Login | null>(null);
  const [starting, setStarting] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<BookResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([
        getJson<{ accounts: Account[]; pool: Pool }>("/api/admin/weread/accounts"),
        getJson<{ sources: ManagedSource[] }>("/api/admin/weread/sources"),
      ]);
      setAccounts(a.accounts);
      setPool(a.pool);
      setSources(s.sources);
    } catch (error) {
      toast(String(error instanceof Error ? error.message : error), "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!login || ENDED.includes(login.status)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const tick = async () => {
      try {
        const state = await getJson<{ status: Login["status"]; message: string }>(`/api/admin/weread/login/${login.id}`);
        if (cancelled) return;
        failures = 0;
        setLogin((prev) => (prev ? { ...prev, status: state.status, message: state.message } : prev));
        if (state.status === "success") {
          toast("微信读书账号已加入账号池", "ok");
          void refresh();
          return;
        }
        if (ENDED.includes(state.status)) return;
      } catch {
        // A dropped poll is not an ended login: retry, but stop if the server stays unreachable.
        failures += 1;
        if (failures >= 5) {
          if (!cancelled) setLogin((prev) => (prev ? { ...prev, status: "failed", message: "连不上服务器，请稍后重新生成二维码" } : prev));
          return;
        }
      }
      if (!cancelled) timer = setTimeout(tick, 1200);
    };
    timer = setTimeout(tick, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [login?.id, login?.status, refresh]);

  const startScan = async () => {
    setStarting(true);
    try {
      const started = await run<{ loginId: string; qr: string }>("POST", "/api/admin/weread/login");
      if (started) setLogin({ id: started.loginId, qr: started.qr, status: "scanning", message: "请用微信扫描二维码，并在手机上确认登录" });
    } finally {
      setStarting(false);
    }
  };

  const search = async () => {
    const value = keyword.trim();
    if (!value) return;
    setSearching(true);
    setResults(null);
    try {
      const found = await run<{ results: BookResult[] }>("POST", "/api/admin/weread/search", { keyword: value }, { revalidate: false });
      if (found) setResults(found.results);
    } finally {
      setSearching(false);
    }
  };

  const add = async (book: BookResult) => {
    const created = await run<{ created: boolean; source?: { id: string; name: string }; duplicate?: { id: string; name: string } }>(
      "POST",
      "/api/admin/weread/sources",
      { bookId: book.bookId, nickname: book.nickname },
      { revalidate: false },
    );
    if (!created) return;
    if (created.duplicate) toast(`已经在监控：${created.duplicate.name}`, "info");
    else toast(`已加入《${created.source?.name ?? book.nickname}》，稍后自动抓取第一批文章`, "ok");
    void refresh();
  };

  const removeAccount = async (account: Account) => {
    if (!window.confirm(`删除微信读书账号「${account.nickname}」？之后需要重新扫码。已经抓到的文章不受影响。`)) return;
    const done = await run<{ ok: boolean }>("DELETE", `/api/admin/weread/accounts/${account.id}`, undefined, { revalidate: false });
    if (done) void refresh();
  };

  const refreshToken = async (account: Account) => {
    const done = await run<{ ok: boolean }>("POST", `/api/admin/weread/accounts/${account.id}/refresh`, undefined, { revalidate: false });
    if (done) void refresh();
  };

  const collectNow = async (source: ManagedSource) => {
    const done = await run("POST", `/api/admin/sources/${encodeURIComponent(source.id)}/fetch`, undefined, { label: `fetch:${source.id}`, revalidate: false });
    if (done) {
      toast("抓取完成，正在刷新", "ok");
      void refresh();
    }
  };

  return (
    <AdminPage
      title="微信读书采集"
      subtitle="扫码登录微信读书账号，再用它添加公众号、抓取文章。可以扫码加多个账号分摊请求、互相接替冷却。账号与凭据只保存在本站后端，页面上不会显示 Token。"
    >
      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="扫码登录" right={login && !ENDED.includes(login.status) ? <Badge tone="warn">{login.status === "scanned" ? "已扫码" : "等待扫码"}</Badge> : undefined}>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <div className="flex size-56 shrink-0 items-center justify-center rounded-card bg-white p-2 ring-1 ring-line">
              {login ? (
                <img src={login.qr} alt="微信扫码登录二维码" className="size-full object-contain" />
              ) : (
                <span className="px-4 text-center text-[12.5px] text-ink-4">点击右侧按钮生成二维码</span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-ink-2">
                用手机微信扫描左侧二维码，确认后会自动加入账号池。二维码约 5 分钟有效；过期后重新生成。
              </p>
              {login && <p className="mt-2 text-[13px] text-ink-3">{login.message}</p>}
              <div className="mt-4 flex flex-wrap gap-2">
                <Button tone="primary" busy={starting || pending === "POST /api/admin/weread/login"} onClick={startScan}>
                  {login && !ENDED.includes(login.status) ? "重新生成二维码" : "生成二维码"}
                </Button>
                {login && !ENDED.includes(login.status) && (
                  <Button tone="ghost" onClick={() => setLogin(null)}>隐藏二维码</Button>
                )}
              </div>
              <p className="mt-4 text-[12px] leading-relaxed text-ink-4">
                扫码登录的是你自己的微信读书账号。微信读书可能对频繁请求限流或要求人机验证；本模块遇到这种情况会停下来、让账号冷却，不会尝试绕过验证。
              </p>
            </div>
          </div>
        </Card>

        <Card
          title="账号池"
          right={
            <div className="flex flex-wrap items-center gap-2">
              {pool && (
                <>
                  <Badge tone={pool.ready > 0 ? "ok" : pool.total > 0 ? "warn" : "muted"}>
                    可用 {pool.ready}/{pool.total}
                  </Badge>
                  {pool.nextAt && <span>下一个可请求 {ago(pool.nextAt)}</span>}
                  <span>本小时共 {pool.requestsThisHour}/{pool.hourlyBudget} 次</span>
                  <span>间隔约 {(pool.intervalMs / 1000).toFixed(1)} 秒</span>
                </>
              )}
              <Button size="sm" tone="ghost" onClick={() => void refresh()}>刷新</Button>
            </div>
          }
        >
          <DataTable
            rows={accounts}
            rowKey={(a) => a.id}
            empty={loading ? "读取中…" : "还没有账号，先扫码登录一个。"}
            columns={[
              {
                key: "account",
                label: "账号",
                render: (a) => (
                  <div className="flex items-center gap-2">
                    {a.avatar ? <img src={a.avatar} alt="" className="size-6 rounded-full object-cover" /> : null}
                    <div className="min-w-0">
                      <div className="truncate font-medium text-ink">{a.nickname}</div>
                      <div className="truncate text-[11.5px] text-ink-4">vid {a.vid}</div>
                    </div>
                  </div>
                ),
              },
              {
                key: "status",
                label: "状态",
                render: (a) => (
                  <div>
                    <Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge>
                    {a.status === "cooling" && a.cooldownUntil && <div className="mt-1 text-[11.5px] text-ink-4">{ago(a.cooldownUntil)}恢复</div>}
                    {a.cooldownLevel > 0 && <div className="mt-1 text-[11.5px] text-ink-4">冷却等级 {a.cooldownLevel}</div>}
                  </div>
                ),
              },
              {
                key: "pacing",
                label: "节奏",
                render: (a) => (
                  <div>
                    <div className="text-ink-2">
                      本小时 <span className="num">{a.requestsHour}</span>/<span className="num">{a.hourlyBudget}</span>
                    </div>
                    <div className="mt-1 text-[11.5px] text-ink-4">
                      {a.nextAllowedAt ? <>{ago(a.nextAllowedAt)}可请求</> : "现在可请求"}
                    </div>
                  </div>
                ),
              },
              { key: "used", label: "上次使用", render: (a) => <Time at={a.lastUsedAt} /> },
              {
                key: "actions",
                label: "",
                align: "right",
                render: (a) => (
                  <div className="flex justify-end gap-1">
                    <Button size="sm" tone="ghost" busy={pending === `POST /api/admin/weread/accounts/${a.id}/refresh`} onClick={() => void refreshToken(a)}>
                      刷新凭据
                    </Button>
                    <Button size="sm" tone="ghost" busy={pending === `DELETE /api/admin/weread/accounts/${a.id}`} onClick={() => void removeAccount(a)}>
                      删除
                    </Button>
                  </div>
                ),
              },
            ]}
          />
          {accounts.some((a) => a.lastError) && (
            <div className="mt-3 space-y-1 text-[12px] text-hot">
              {accounts.filter((a) => a.lastError).map((a) => <div key={a.id}>{a.nickname}：{a.lastError}</div>)}
            </div>
          )}
        </Card>
      </div>

      <div className="mt-5">
        <Card title="添加公众号" right={results ? <Badge tone="muted">{results.length} 个结果</Badge> : undefined}>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Field label="公众号名称，或一篇文章的链接" hint="链接里带 __biz 时可以直接定位；名称走微信读书的公众号搜索。">
                <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void search(); }} placeholder="例如：中国教育报，或 https://mp.weixin.qq.com/s/…" />
              </Field>
            </div>
            <Button tone="primary" busy={searching} disabled={!keyword.trim()} onClick={() => void search()}>搜索</Button>
          </div>
          {results && (
            <div className="mt-4">
              <DataTable
                rows={results}
                rowKey={(b) => b.bookId}
                empty="没有找到公众号，换一个关键词或直接粘贴文章链接。"
                columns={[
                  {
                    key: "name",
                    label: "公众号",
                    render: (b) => (
                      <div className="flex items-center gap-3">
                        {b.cover ? <img src={b.cover} alt="" className="size-9 rounded-mark object-cover" /> : null}
                        <div className="min-w-0">
                          <div className="font-medium text-ink">{b.nickname}</div>
                          <div className="line-clamp-1 text-[11.5px] text-ink-4">{b.intro || b.bookId}</div>
                        </div>
                      </div>
                    ),
                  },
                  {
                    key: "add",
                    label: "",
                    align: "right",
                    render: (b) => (
                      <Button size="sm" tone="primary" busy={pending === "POST /api/admin/weread/sources"} onClick={() => void add(b)}>添加</Button>
                    ),
                  },
                ]}
              />
            </div>
          )}
        </Card>
      </div>

      <div className="mt-5">
        <Card title="已接入的公众号" right={<Button size="sm" tone="ghost" onClick={() => void refresh()}>刷新</Button>}>
          <DataTable
            rows={sources}
            rowKey={(s) => s.id}
            empty={loading ? "读取中…" : "还没有公众号。搜索后点「添加」，它会成为一个公众号类型的信源。"}
            columns={[
              {
                key: "name",
                label: "公众号",
                render: (s) => (
                  <div className="min-w-0">
                    <Link to={`/admin/sources/${encodeURIComponent(s.id)}`} className="font-medium text-ink hover:text-accent">{s.name}</Link>
                    <div className="truncate text-[11.5px] text-ink-4">{s.id}</div>
                  </div>
                ),
              },
              {
                key: "health",
                label: "健康",
                render: (s) => (
                  <div>
                    <Badge tone={healthTone(s.health)}>{s.health}</Badge>
                    {!s.enabled && <div className="mt-1 text-[11.5px] text-ink-4">已暂停</div>}
                  </div>
                ),
              },
              { key: "interval", label: "间隔", align: "right", render: (s) => `${s.intervalMinutes} 分钟` },
              { key: "articles", label: "文章", align: "right", render: (s) => s.articles },
              { key: "last", label: "上次抓取", render: (s) => <Time at={s.lastFetchAt} title={s.lastFetchAt ? bj(s.lastFetchAt, true) : undefined} /> },
              {
                key: "actions",
                label: "",
                align: "right",
                render: (s) => (
                  <Button size="sm" tone="secondary" busy={pending === `fetch:${s.id}`} onClick={() => void collectNow(s)}>立即抓取</Button>
                ),
              },
            ]}
          />
          {sources.some((s) => s.lastError) && (
            <div className="mt-3 space-y-1 text-[12px] text-hot">
              {sources.filter((s) => s.lastError).map((s) => <div key={s.id}>{s.name}：{s.lastError}</div>)}
            </div>
          )}
        </Card>
      </div>

    </AdminPage>
  );
}
