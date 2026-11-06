import { useState } from "react";
import type { AdminPrefilterPreview, AdminPrefilterResult } from "@aihot/contracts/admin";
import { useAdminAction } from "./action";
import { Button, ReasonDialog } from "./ui";

export function PrefilterReview({ scope, disabled, onApplied }: { scope: { q: string; all: true } | { ids: string[] }; disabled?: boolean; onApplied?: () => void }) {
  const { run, pending } = useAdminAction();
  const [preview, setPreview] = useState<AdminPrefilterPreview | null>(null);
  const [result, setResult] = useState<AdminPrefilterResult | null>(null);
  return <>
    <Button disabled={disabled || !!pending} onClick={async () => {
      const next = await run<AdminPrefilterPreview>("POST", "/api/admin/content/prefilter-pass/preview", scope, { revalidate: false });
      if (next) setPreview(next);
    }}>人工判为 PASS</Button>
    <ReasonDialog open={!!preview} title="人工预筛通过预览" confirmLabel="确认预筛通过并继续分析"
      description={<>
        <p>本次范围 {preview?.total ?? 0} 条，可审核 {preview?.eligible ?? 0} 条；其余跳过。原始 UNKNOWN 和计费回执保留。</p>
        <p>只放行预筛，继续通用模型分析；不立即公开，不解除人工下架或其他拦截。后续分析可能产生模型费用，仍受预算限制。</p>
      </>}
      busy={!!pending || !preview?.eligible} onClose={() => { if (!pending) setPreview(null); }}
      onSubmit={async reason => {
        if (!preview?.eligible) return false;
        const next = await run<AdminPrefilterResult>("POST", "/api/admin/content/prefilter-pass", { token: preview.token, reason },
          { label: `prefilter-pass:${preview.token}`, success: value => `${value.succeeded} 条已预筛通过并排队分析，${value.skipped} 条跳过，${value.failed} 条失败；尚不代表公开` });
        if (!next) return false;
        setResult(next);
        onApplied?.();
        return true;
      }}>
      <ul className="max-h-56 space-y-1 overflow-y-auto text-[12px] text-ink-3">
        {preview?.rows.map(row => <li key={row.id}>{row.title}{row.reason ? ` · 跳过：${row.reason}` : " · 预筛 UNKNOWN → 人工 PASS"}</li>)}
      </ul>
    </ReasonDialog>
    {result && <div className="w-full rounded-control bg-bg-sunk p-3 text-[12px] text-ink-3">
      <p>已排队 {result.succeeded} 条，跳过 {result.skipped} 条，失败 {result.failed} 条；请在内容详情跟踪后续分析。</p>
      <ul className="max-h-48 overflow-y-auto">{result.rows.filter(row => row.status !== "succeeded").map(row => <li key={row.id}>{row.id} · {row.reason}</li>)}</ul>
    </div>}
  </>;
}
