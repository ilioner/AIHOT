import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { createSource } from "@aihot/backend/admin/sources";
import { updateCategories } from "@aihot/backend/admin/settings";
import { loadCategories } from "@aihot/backend/taxonomy";
import { DEFAULT_CATEGORIES } from "@aihot/contracts/taxonomy";
import { audit } from "@aihot/backend/audit";
import { collectCatalog } from "../backend/collect.ts";
import { SOURCE_IDS } from "../backend/adapters.ts";

const apply = process.argv.includes("--apply");
const collect = process.argv.includes("--collect");
if (collect && !apply) throw new Error("实际采集需要同时指定 --apply --collect");
try {
  const seed = JSON.parse(readFileSync(fileURLToPath(new URL("../../../industry/sources.json", import.meta.url)), "utf8"));
  const definitions = seed.sources.filter((source: { id: string }) => (SOURCE_IDS as readonly string[]).includes(source.id));
  for (const source of definitions) {
    const [known] = await sql`SELECT id, kind FROM sources WHERE id = ${source.id}`;
    if (known && known.kind !== "external") throw new Error(`信源 ${source.id} 已存在且类型不符，请人工检查`);
    if (!known && apply) await createSource(source, "local-admin");
    console.log(JSON.stringify({ sourceId: source.id, action: known ? "preserved" : apply ? "created" : "would-create" }));
  }
  const categories = await loadCategories();
  const tools = DEFAULT_CATEGORIES.find(category => category.key === "ai-tools")!;
  if (!categories.some(category => category.key === tools.key)) {
    if (apply) await updateCategories({ categories: [...categories, tools], reason: "接入工具目录与专题，新增 AI 工具类别；保留全部原有分类" }, "local-admin");
    console.log(JSON.stringify({ category: tools.key, action: apply ? "created" : "would-create" }));
  }
  if (collect) for (const id of SOURCE_IDS) {
    const result = await collectCatalog(id);
    await audit("local-admin", "source.fetch", `source:${id}`, "按用户要求接入原暂未接入信源并首次采集", null, result);
    console.log(JSON.stringify(result));
    if (result.status === "failed") process.exitCode = 1;
  }
} finally { await stopBoss(); await closeDb(); }
