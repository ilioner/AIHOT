import { SITE } from "@aihot/site";
import { useEffect, useState } from "react";
import { Form, Link, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/content";
import type { AdminContentSearch } from "@aihot/contracts/admin";
import { adminGet } from "../../lib/admin.server";
import { PROCESSING_LABEL, VISIBILITY_LABEL } from "../../features/admin/labels";
import { AdminPage, Badge, Button, Card, DataTable, Empty, Input, Select, Time } from "../../features/admin/ui";
import { PrefilterReview } from "../../features/admin/prefilter-review";


export async function loader({ request }: Route.LoaderArgs) {
  const sp = new URL(request.url).searchParams;
  const q = sp.get("q")?.trim() ?? "";
  const prefilter = sp.get("prefilter") ?? "";
  const page = sp.get("page") ?? "1";
  const data = await adminGet<AdminContentSearch>(request, `/api/admin/content?${new URLSearchParams({ q, prefilter, page })}`);
  return { q, prefilter, ...data, total: data.total ?? data.rows.length, page: data.page ?? Number(page) };
}

export const meta: Route.MetaFunction = () => [{ title: `内容诊断 · ${SITE.name} 后台` }];

export default function Content({ loaderData }: Route.ComponentProps) {
  const { q, prefilter, rows, total, page } = loaderData;
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const [selected, setSelected] = useState(new Set<string>());
  const [all, setAll] = useState(false);
  useEffect(() => { setSelected(new Set()); setAll(false); }, [q, prefilter]);
  const selectable = rows.filter(row => row.reviewable);
  const pageSelected = selectable.length > 0 && selectable.every(row => selected.has(row.id));
  const pageLink = (next: number) => { const params = new URLSearchParams(sp); params.set("page", String(next)); return `?${params}`; };
  return (
    <AdminPage title="内容诊断" subtitle="按 ID、原文链接或标题找到任何一条内容，看它从信源到公开出口的完整链路；下架、仅摘要、人工修正和重处理都在详情页。">
      <Form method="get" className="mb-5 flex max-w-3xl flex-wrap gap-2">
        <Input name="q" defaultValue={sp.get("q") ?? ""} placeholder="内容 ID、URL 或标题关键词" aria-label="搜索内容" autoFocus />
        <Select name="prefilter" defaultValue={prefilter} aria-label="预筛结果筛选">
          <option value="">全部预筛结果</option><option value="UNKNOWN">UNKNOWN（未确定）</option>
          <option value="BLOCK">BLOCK（拦截）</option><option value="PASS">PASS（通过）</option>
        </Select>
        <Button type="submit" tone="primary">查找</Button>
      </Form>
      {(q || prefilter) && (
        <Card pad={false} title={q ? `“${q}” 的结果` : `${prefilter} 预筛结果`} right={<span>{total} 条 · 第 {page} 页</span>}>
          <div className="flex flex-wrap items-center gap-2 border-b border-line p-4 text-[12px] text-ink-3">
            <span>{all ? `已选择全部匹配 ${total} 条` : `已勾选 ${selected.size} 条`}</span>
            {prefilter === "UNKNOWN" && <Button onClick={() => setAll(true)}>选择全部匹配 {total} 条</Button>}
            <Button onClick={() => { setSelected(new Set()); setAll(false); }}>清除选择</Button>
            <PrefilterReview scope={all ? { q, all: true } : { ids: [...selected] }} disabled={!all && !selected.size}
              onApplied={() => { setSelected(new Set()); setAll(false); }} />
            <p className="w-full">此处 UNKNOWN 指当前版本的原始预筛标签，不是材料或写作不足产生的最终 unknown；人工已通过或等待处理的条目会跳过。</p>
          </div>
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/admin/content/${r.id}`)}
            empty="没有找到。URL 会先规范化再比对；标题支持中英文片段。"
            columns={[
              { key: "pick", label: <input type="checkbox" aria-label="选择当前页" checked={all || pageSelected} disabled={!selectable.length}
                onChange={event => { setAll(false); setSelected(previous => { const next = new Set(previous); for (const row of selectable) { if (event.target.checked) next.add(row.id); else next.delete(row.id); } return next; }); }} />,
                render: row => <input type="checkbox" aria-label={`选择 ${row.title}`} disabled={!row.reviewable} checked={!!row.reviewable && (all || selected.has(row.id))}
                  onClick={event => event.stopPropagation()} onChange={event => { setAll(false); setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(row.id); else next.delete(row.id); return next; }); }} /> },
              {
                key: "t",
                label: "标题",
                render: (r) => (
                  <div className="min-w-[320px]">
                    <Link to={`/admin/content/${r.id}`} className="font-medium text-ink hover:text-accent" onClick={(e) => e.stopPropagation()}>{r.title}</Link>
                    <div className="font-mono text-[11.5px] text-ink-4">{r.id}</div>
                  </div>
                ),
              },
              { key: "src", label: "信源", render: (r) => <span className="whitespace-nowrap">{r.source}</span> },
              {
                key: "st",
                label: "状态",
                render: (r) => (
                  <span className="flex flex-wrap gap-1">
                    {r.prefilter_label && <Badge title={r.prefilter_reason || "预筛模型未提供具体理由"}>预筛 {r.prefilter_label}</Badge>}
                    {r.manual_prefilter && <Badge tone="info">人工预筛 PASS</Badge>}
                    {r.selected && <Badge tone="accent">精选</Badge>}
                    {(r.status_reason || r.visibility) && <Badge tone={r.visibility === "public" ? "muted" : "warn"}>{r.status_reason ?? VISIBILITY_LABEL[r.visibility!] ?? r.visibility}</Badge>}
                    <Badge>{PROCESSING_LABEL[r.processing_state] ?? r.processing_state}</Badge>
                  </span>
                ),
              },
              { key: "sc", label: "分数", align: "right", render: (r) => r.score ?? "—" },
              { key: "d", label: "发现", render: (r) => <Time at={r.discovered_at} /> },
            ]}
          />
          <div className="flex items-center justify-between p-4 text-[12px] text-ink-3">
            {page > 1 ? <Link to={pageLink(page-1)}>上一页</Link> : <span />}
            <span>第 {page} 页，共 {Math.max(1, Math.ceil(total/50))} 页</span>
            {page*50 < total ? <Link to={pageLink(page+1)}>下一页</Link> : <span />}
          </div>
        </Card>
      )}
      {!q && !prefilter && <Empty>输入 ID、链接或标题开始查找，或选择 UNKNOWN 筛选进行批量人工审核。</Empty>}
    </AdminPage>
  );
}
