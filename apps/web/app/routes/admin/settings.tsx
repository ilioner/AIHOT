import { ADMIN, SITE } from "@aihot/site";
import { useState } from "react";
import type { Route } from "./+types/settings";
import type { AdminSettings } from "@aihot/contracts/admin";
import { CATEGORY_KEY_PATTERN, type CategoryDefinition } from "@aihot/contracts/taxonomy";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, Field, Input, ReasonDialog, Textarea } from "../../features/admin/ui";
import { toast } from "../../features/admin/toast";


export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<AdminSettings>(request, "/api/admin/settings");
}

export const meta: Route.MetaFunction = () => [{ title: `设置 · ${SITE.name} 后台` }];


const emptyCategory = (): CategoryDefinition => ({ key: "", label: "", tag: "", section: "", guide: "", tagColor: "gray", feedLabel: "", commentary: false, enabled: true });

function CategoryManager({ categories: initial }: { categories: CategoryDefinition[] }) {
  const { run, pending } = useAdminAction();
  const [categories, setCategories] = useState<CategoryDefinition[]>(initial);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CategoryDefinition | null>(null);
  const [isNew, setIsNew] = useState(false);
  const changed = JSON.stringify(categories) !== JSON.stringify(initial);
  const update = (index: number, patch: Partial<CategoryDefinition>) => setCategories((current) => current.map((item, i) => i === index ? { ...item, ...patch } : item));
  const move = (index: number, offset: -1 | 1) => setCategories((current) => {
    const next = [...current]; const target = index + offset;
    if (target < 0 || target >= next.length) return current;
    [next[index], next[target]] = [next[target]!, next[index]!];
    return next;
  });
  const edit = (index: number) => { setIsNew(false); setDraft({ ...categories[index]! }); };
  const add = () => { setIsNew(true); setDraft(emptyCategory()); };
  const applyDraft = () => {
    if (!draft) return;
    const value = { ...draft, label: draft.label.trim(), tag: draft.tag.trim(), section: draft.section.trim(), guide: draft.guide.trim(), feedLabel: draft.feedLabel?.trim() || undefined };
    if (isNew) setCategories((current) => [...current, value]);
    else setCategories((current) => current.map((item) => item.key === draft.key ? value : item));
    setDraft(null);
  };
  return <>
    <Card className="mb-5" title="分类管理" right={<Button size="sm" tone="primary" disabled={!!draft || pending !== null} onClick={add}>新增分类</Button>}>
      <p className="mb-4 text-[12.5px] leading-relaxed text-ink-3">“全部”和“一手”是固定筛选，不属于分类，不能编辑。下方顺序用于分类选项；停用后不再用于新内容归类，但不删除历史内容与旧链接。所有改动先保留在此页，点击“保存分类设置”并填写原因后才会生效。</p>
      {draft && <form className="mb-4 rounded-card bg-bg-sunk/50 p-4 ring-1 ring-line-strong" onSubmit={(event) => {
        event.preventDefault();
        if (isNew && categories.some((category) => category.key === draft.key.trim() || category.tag === draft.tag.trim())) {
          toast("分类 key 和标签不能重复", "error");
          return;
        }
        if (![draft.key, draft.label, draft.tag, draft.section, draft.guide].every((value) => value.trim())) return;
        applyDraft();
      }}>
        <h3 className="mb-3 text-[14px] font-semibold text-ink">{isNew ? "新增分类" : `编辑：${draft.label}`}</h3>
        <p className="mb-3 text-[12px] text-ink-3">key 用于网址和接口，标签用于结构化；创建后都不能修改。分类不能删除，只能停用。</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="key" hint={isNew ? "小写字母开头，只用小写字母、数字和连字符" : "创建后不可改"}><Input aria-label="分类 key" required value={draft.key} disabled={!isNew} maxLength={60} pattern={CATEGORY_KEY_PATTERN.source} onChange={(e) => setDraft({ ...draft, key: e.target.value })} /></Field>
        <Field label="显示名称"><Input aria-label="分类显示名称" required value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></Field>
        <Field label="分类标签" hint={isNew ? "模型结构化时使用；创建后不可改" : "创建后不可改"}><Input aria-label="分类标签" required value={draft.tag} disabled={!isNew} onChange={(e) => setDraft({ ...draft, tag: e.target.value })} /></Field>
        <Field label="日报栏目"><Input aria-label="日报栏目" required value={draft.section} onChange={(e) => setDraft({ ...draft, section: e.target.value })} /></Field>
        <Field label="机器出口名称" hint="可选；留空使用显示名称"><Input aria-label="机器出口名称" value={draft.feedLabel ?? ""} onChange={(e) => setDraft({ ...draft, feedLabel: e.target.value })} /></Field>
        <p className="self-center text-[12px] text-ink-4">推送标签颜色：{draft.tagColor}（新增默认 gray）</p>
        <label className="flex items-center gap-2 text-[13px] text-ink-2"><input type="checkbox" className="size-4 accent-[var(--accent)]" checked={!!draft.commentary} onChange={(e) => setDraft({ ...draft, commentary: e.target.checked })} />评论类（教程、观点）</label>
        <label className="flex items-center gap-2 text-[13px] text-ink-2"><input type="checkbox" className="size-4 accent-[var(--accent)]" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />启用</label>
        <div className="sm:col-span-2"><Field label="分类说明" hint="写清收什么，以及与相邻分类的边界"><Textarea aria-label="分类说明" required rows={4} value={draft.guide} onChange={(e) => setDraft({ ...draft, guide: e.target.value })} /></Field></div>
      </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button tone="ghost" onClick={() => setDraft(null)}>取消编辑</Button>
          <Button type="submit" tone="primary">{isNew ? "加入列表" : "应用编辑"}</Button>
        </div>
      </form>}
      <fieldset disabled={!!draft || pending !== null} className="min-w-0 space-y-2">
        {categories.map((category, index) => <div key={`${category.key}-${index}`} className={`rounded-card p-3 ring-1 ${category.enabled ? "bg-surface ring-line" : "bg-bg-sunk/60 ring-line-soft"}`}>
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><span className="font-medium text-ink">{category.label || category.key || "未命名分类"}</span><Badge tone={category.enabled ? "ok" : "muted"}>{category.enabled ? "启用" : "停用"}</Badge>{category.commentary && <Badge>评论</Badge>}</div>
              <div className="mt-1 break-all font-mono text-[11.5px] text-ink-4">{category.key || "未填写 key"} · 标签 {category.tag || "未填写"} · {category.section || "未分栏目"}</div>
              {category.feedLabel && <div className="mt-1 text-[12px] text-ink-3">机器出口名称：{category.feedLabel}</div>}
            </div>
            <div className="flex shrink-0 flex-wrap gap-1.5">
              <Button size="sm" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`上移 ${category.label || category.key}`}>上移</Button>
              <Button size="sm" onClick={() => move(index, 1)} disabled={index === categories.length - 1} aria-label={`下移 ${category.label || category.key}`}>下移</Button>
              <Button size="sm" onClick={() => update(index, { enabled: !category.enabled })}>{category.enabled ? "停用" : "启用"}</Button>
              <Button size="sm" tone="primary" onClick={() => edit(index)}>编辑</Button>
            </div>
          </div>
        </div>)}
      </fieldset>
      {!categories.length && <p className="py-5 text-center text-[13px] text-ink-4">暂无分类，请新增至少一个启用分类。</p>}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line-soft pt-4">
        <span className="text-[12px] text-ink-4">{categories.filter((category) => category.enabled).length} 个启用 · {categories.length} 个总计</span>
        <Button tone="primary" disabled={!changed || !!draft || pending !== null} onClick={() => setOpen(true)}>保存分类设置</Button>
      </div>
    </Card>
    <ReasonDialog
      open={open}
      title="保存分类设置"
      description="保存分类顺序、文案和启停状态。至少保留一个启用分类；后端会再次校验。"
      confirmLabel="保存"
      busy={pending === "categories"}
      onClose={() => setOpen(false)}
      onSubmit={async (reason) => (await run("PUT", "/api/admin/settings/categories", { categories, reason }, { label: "categories", success: "分类设置已保存" })) !== null}
    />

  </>;
}

function BudgetRow({ b }: { b: AdminSettings["budgets"][number] }) {
  const { run, pending } = useAdminAction();
  const [v, setV] = useState({ perMinute: b.per_minute, perHour: b.per_hour, perDay: b.per_day });
  const [open, setOpen] = useState(false);
  const changed = v.perMinute !== b.per_minute || v.perHour !== b.per_hour || v.perDay !== b.per_day;
  return (
    <tr className="border-b border-line/70 last:border-0">
      <td className="px-3 py-2 font-mono text-[12.5px]">{b.service}</td>
      {(["perMinute", "perHour", "perDay"] as const).map((k) => (
        <td key={k} className="px-3 py-2">
          <Input type="number" min={0} className="!w-24 !py-1 text-right" value={v[k]} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} />
        </td>
      ))}
      <td className="num px-3 py-2 text-right text-ink-3">{num(b.used_hour)} / {num(b.used_day)}</td>
      <td className="px-3 py-2 text-right">
        <Button size="sm" tone="primary" disabled={!changed} onClick={() => setOpen(true)}>保存</Button>
        <ReasonDialog
          open={open}
          title={`调整 ${b.service} 的请求上限`}
          description={`上限是付费请求的熔断：超过后请求暂停并按窗口重试。填 0 表示立即停用这个服务。${ADMIN.budgetNote ?? ""}`}
          confirmLabel="保存"
          busy={pending === "budget"}
          onClose={() => setOpen(false)}
          onSubmit={async (reason) => (await run("PUT", `/api/admin/budgets/${encodeURIComponent(b.service)}`, { ...v, reason }, { label: "budget", success: "上限已更新" })) !== null}
        />
      </td>
    </tr>
  );
}

export default function SettingsAdmin({ loaderData: s }: Route.ComponentProps) {
  return (
    <AdminPage title="设置" subtitle="不改代码即可替换的运营设置。每次修改都写入审计记录。">
      <CategoryManager key={JSON.stringify(s.categories)} categories={s.categories} />
      <Card className="mt-5" title="付费请求上限" right={<span>已用：近 1 小时 / 近 24 小时</span>} pad={false}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-ink-3">
                <th className="px-3 py-2 font-medium">服务</th>
                <th className="px-3 py-2 font-medium">每分钟</th>
                <th className="px-3 py-2 font-medium">每小时</th>
                <th className="px-3 py-2 font-medium">每天</th>
                <th className="px-3 py-2 text-right font-medium">已用</th>
                <th />
              </tr>
            </thead>
            <tbody>{s.budgets.map((b) => <BudgetRow key={`${b.service}-${b.updated_at}`} b={b} />)}</tbody>
          </table>
        </div>
      </Card>
    </AdminPage>
  );
}
