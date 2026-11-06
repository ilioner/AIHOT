// 这个行业的分类体系：类别、标签词表、公司（主体）名录，以及防止张冠李戴的身份词典。
// 模型按这里的词表打标签，主题页（topics.json）按标签归类，筛选栏按类别分组。
// 换行业时：类别的 key 会出现在网址里（/all?category=…），上线后就不要再改；标签和名录可以随时增减。

/**
 * 网页上的类别（筛选栏、卡片角标、RSS 分类订阅）。key 是网址和接口里的身份，上线后不要改。
 * section 是日报里的分节标题（几个类别可以共用一节，按这里的顺序排）；guide 告诉结构抽取模型这一类收什么、
 * 和相邻类别的边界在哪（总的归类原则写在 prompts/structure.md 里）。
 * commentary 标出评论类（教程、观点）：日报写过的事又有评论类的后续报道，只占一行快讯（报道它的信源够多时除外）。
 * 没归上类的资料在日报里放进第一个 key 为 industry 的类别所在的节（没有就放最后一节）。
 * tagColor 是飞书推送卡片里跟在标题后面的这一类小标签的颜色（飞书 text_tag 的颜色名）。
 * feedLabel 是分类 RSS 标题里的名字（不写就用 label）。公开接口、RSS 和 MCP 里要把一类并进另一类发布，写在站点设置里（site/site.ts 的 PUBLIC_CATEGORIES）。
 */
export const CATEGORIES = [
  { key: "policy", tagColor: "indigo", label: "政策", feedLabel: "职教政策", section: "政策文件", guide: "教育信息化、AI＋教育／职教的教学改革指导、使用约束、标准与规范：发布、解读、征求意见、生效与实施要求。按实际适用对象和规定事项归类，保留文件阶段；一般行政通知不因发布机构级别高而属于本站政策范围。" },
  { key: "ai-teaching", tagColor: "turquoise", label: "AI 赋能教学", feedLabel: "AI 赋能教学", section: "AI 赋能教学", guide: "原文提供与教师任务直接相关的 AI 工具、平台或模型能力发布，以及课堂、实训、备课与评价中的实际应用。无需已有职业院校部署，但不能把可能教学用途写成已落地；无教学关联的通用 AI 实践、演示、玩法与工作流归教程，不能为了贴合读者补出教学标签。核心是技术影响的论证时归观点。" },
  { key: "ai-tools", tagColor: "blue", label: "AI 工具", section: "AI 工具与资源", guide: "AI 工具目录、资源导航与专题推荐，介绍已经可用的工具用途、能力或使用条件，覆盖教学、学习、办公、创作与求职辅助。收录或首次发现不代表产品新发布；不能编造上新日期或院校应用。以步骤示例为主归教程，有明确新能力发布或课堂应用证据时归 AI 赋能教学，行业经营新闻不归工具。" },
  { key: "industry", tagColor: "orange", label: "行业", feedLabel: "行业动态", section: "行业动态", guide: "与 AI 教学或教育信息化有关、已经发生的服务开放、交付、合作实施或运行变化。签约揭牌、融资人事和机构表态本身不是教学内容；材料以具体教程、研究或政策要求为核心时归对应类别。新闻由当事人发帖、带有态度，也不因此变成观点。" },
  { key: "skills", tagColor: "violet", label: "技能与竞赛", feedLabel: "技能与竞赛", section: "技能与竞赛", guide: "与 AI 教学、教师应用能力或智能实训有关的竞赛、能力认定安排、结果与规则变化。名次和颁奖不等于可复用方法；核心在讲解参赛教案、提示词、工作流或评价方法时归教程。" },
  { key: "research", tagColor: "green", label: "研究", feedLabel: "研究与报告", section: "研究与报告", guide: "以研究设计、实验、评估数据与发现为核心的 AI 教学、学习评价、教师工作、技术能力或风险研究。区分技术测评与教学效果证据；政策要求解读归政策，以操作流程为主的实测归教程，不能只因出现数字就归研究。" },
  { key: "tip", tagColor: "amber", label: "教程", section: "技巧与观点", guide: "AI 教学方法及通用 AI 实践、演示与玩法：图像、音视频、动画、SVG、网页、游戏、3D 创作，提示词、智能体／Skills／MCP 与自动化工作流，AI 编程、数据分析、硬件与多模态应用，工具实测、对比、失败复盘、模型部署、API 接入与推理优化。能辨认 AI、任务及具体方法、结果、演示或经验即可，无需教师任务关联、新发布、成功完成、源码或完整复现步骤；只有任务与结果时如实称演示或案例，不冒充完整教程。官方展示不等于独立验证。工具目录归 AI 工具；有明确教学关联的新能力发布归 AI 赋能教学，以研究证据为主归研究，以影响论证为主归观点。", commentary: true },
  { key: "opinion", tagColor: "purple", label: "观点", section: "技巧与观点", guide: "围绕 AI 教学、教育信息化、相关政策或技术影响，有事实与推理支持的解释、判断、复盘、预测或访谈观点。可能的教学迁移不得写成已验证效果；以文件要求和适用范围为核心的解读归政策，作者是名人不自动归观点。", commentary: true },
] as const satisfies ReadonlyArray<{ key: string; tagColor: string; label: string; feedLabel?: string; section: string; guide: string; commentary?: true }>;

/** Stable first-tag identities, separate from editable display names. */
export const CATEGORY_FIRST_TAGS: Readonly<Record<string, string>> = {
  policy: "政策文件", "ai-teaching": "AI赋能教学", industry: "行业动态", skills: "技能竞赛",
  research: "研究/报告", tip: "教程/实践", opinion: "观点/趋势", "ai-tools": "AI工具",
};

/**
 * 这个行业最受关注的一类发布：日报报头的“N 份新文件”、改分类后修订已出的报告都按它数。
 * category 是类别，tag 是标签，两者都对上才算；unit 接在数字后面。
 * 没有这样一类的行业设成 null，报头就不显示这个数。
 */
export const RELEASE: { category: string; tag: string; unit: string } | null = { category: "policy", tag: "政策文件", unit: "份新文件" };

/** 周报月报的总述可以直接写、不必在报道里找到出处的行业通用词（小写）。站名会自动算进去。 */
export const PLAIN_TERMS: readonly string[] = ["ai", "职教", "高职", "中职", "产教融合", "校企合作", "双高", "职教高考", "1+x", "双师型", "工匠"];

/**
 * 内容理解一步给每篇资料判的“内容类型”（写在 prompts/content-understanding.md 里，改了类型要同步改那份提示词）。
 * 评分提示词（prompts/selection-score.md）按类型给五个维度不同的权重。
 */
export const ITEM_TYPES = ["policy_release", "ai_in_teaching", "industry_event", "research_report", "competition_result", "opinion_analysis", "tutorial_explainer"] as const;

// ── 标签词表 ────────────────────────────────────────────────────────────────────────────

/** 每篇资料的第一个标签必须是这些“分类标签”之一。 */
export const CATEGORY_TAGS = [
  "政策文件", "AI赋能教学", "AI工具", "行业动态", "技能竞赛", "研究/报告", "教程/实践", "观点/趋势", "其他",
] as const;

/** 可选的主题标签。 */
export const TOPIC_TAGS = [
  "产教融合", "校企合作", "实训基地", "职教高考", "专业建设", "课程改革", "师资队伍", "招生就业", "技能大赛", "证书认定", "数字校园", "智慧实训", "AI助教", "智能评价", "安全/风险",
] as const;

/** 可选的实体标签（机构、平台）。 */
export const ENTITY_TAGS = ["教育部", "人社部", "联合国教科文组织", "腾讯", "百度", "阿里云", "华为", "科大讯飞", "新道科技", "智慧树", "超星"] as const;

/** 模型常写的近义词，统一成词表里的写法。 */
export const TAG_SYNONYMS: Readonly<Record<string, string>> = {
  "ai工具": "AI工具", 工具推荐: "AI工具", 工具目录: "AI工具",
  政策: "政策文件", 文件: "政策文件", 通知: "政策文件", 法规: "政策文件", 监管: "政策文件", 规划: "政策文件", 标准: "政策文件",
  "ai": "AI赋能教学", "ai教育": "AI赋能教学", "ai+教育": "AI赋能教学", 智能教育: "AI赋能教学", 教育科技: "AI赋能教学", 数字化: "AI赋能教学", 数字化转型: "AI赋能教学", 智慧教育: "AI赋能教学", 人工智能: "AI赋能教学",
  行业: "行业动态", 动态: "行业动态", 公司动态: "行业动态", 融资: "行业动态", 收购: "行业动态", 投资: "行业动态", 并购: "行业动态", 合作: "行业动态",
  竞赛: "技能竞赛", 大赛: "技能竞赛", 技能大赛: "技能竞赛", 赛事: "技能竞赛", 比赛: "技能竞赛", 证书: "证书认定", 认定: "证书认定",
  论文: "研究/报告", 研究: "研究/报告", 报告: "研究/报告", 白皮书: "研究/报告", paper: "研究/报告", papers: "研究/报告",
  教程: "教程/实践", 玩法: "教程/实践", 指南: "教程/实践", 技巧: "教程/实践", 最佳实践: "教程/实践", 实践: "教程/实践", 案例: "教程/实践",
  观点: "观点/趋势", 趋势: "观点/趋势", 现象: "观点/趋势", 评论: "观点/趋势", 评论文章: "观点/趋势",
  产教: "产教融合", 校企: "校企合作", 实训: "智慧实训", 双师: "师资队伍", 就业: "招生就业", 招生: "招生就业",
  安全: "安全/风险", 风险: "安全/风险",
};

// ── 机构与主体 ──────────────────────────────────────────────────────────────────────────

/**
 * 机构主题：id → 显示名、卡片上显示的标签（null 表示只用 entity:<id> 归类）、别名。
 * aliases 给结构抽取模型看；orgNames 是这家机构发消息时开头用的组织名（部委、学校、企业、团队），
 * 在它自己的主题页上读者知道说的是谁，可以省去；otherNames 是机构的其他称呼（官方账号名、子品牌）。
 * 所有这些名字都用来认出说的是哪家机构，比如把事实的主体对到发布方。
 */
export const ENTITIES: Record<string, { name: string; displayTag: string | null; aliases: string[]; orgNames?: string[]; otherNames?: string[] }> = {
  moe: { name: "教育部", displayTag: "教育部", aliases: ["教育部", "Ministry of Education", "教育部办公厅"], orgNames: ["教育部", "中华人民共和国教育部", "教育部办公厅", "教育部职业教育与成人教育司"], otherNames: ["微言教育", "职成司"] },
  mohrss: { name: "人社部", displayTag: null, aliases: ["人社部", "人力资源和社会保障部", "人力资源社会保障部"], orgNames: ["人力资源和社会保障部", "人力资源社会保障部", "人社部"] },
  unesco: { name: "联合国教科文组织", displayTag: null, aliases: ["UNESCO", "联合国教科文组织", "联合国教科文"], orgNames: ["UNESCO", "联合国教科文组织"] },
  tencent: { name: "腾讯", displayTag: "腾讯", aliases: ["腾讯", "Tencent"], orgNames: ["腾讯", "Tencent"], otherNames: ["腾讯教育", "腾讯云"] },
  baidu: { name: "百度", displayTag: null, aliases: ["百度", "Baidu"], orgNames: ["百度", "Baidu"], otherNames: ["百度教育", "文心"] },
  aliyun: { name: "阿里云", displayTag: null, aliases: ["阿里云", "阿里巴巴", "阿里"], orgNames: ["阿里巴巴", "阿里云", "Alibaba Cloud"], otherNames: ["钉钉", "钉钉教育", "通义"] },
  huawei: { name: "华为", displayTag: null, aliases: ["华为", "Huawei", "华为云"], orgNames: ["华为", "Huawei"] },
  iflytek: { name: "科大讯飞", displayTag: null, aliases: ["科大讯飞", "讯飞", "iFlytek"], orgNames: ["科大讯飞", "iFlytek"], otherNames: ["讯飞教育"] },
  xiandao: { name: "新道科技", displayTag: null, aliases: ["新道科技", "新道"], orgNames: ["新道科技", "新道"] },
  zhihuishu: { name: "智慧树", displayTag: null, aliases: ["智慧树", "Zhihuishu"], orgNames: ["智慧树"] },
  chaoxing: { name: "超星", displayTag: null, aliases: ["超星", "学习通", "Chaoxing"], orgNames: ["超星", "超星集团"] },
};

/**
 * 身份词典：摘要和标题里出现的机构，必须在原文里也出现过，否则退回原标题、丢掉摘要（防止模型张冠李戴）。
 * 行业没有这个问题时可以留空数组。
 */
export const IDENTITY_LEXICON: ReadonlyArray<{ id: string; name: string; patterns: RegExp[] }> = [
  { id: "moe", name: "教育部", patterns: [/教育部|\bMinistry of Education\b/i, /职业教育与成人教育司|职成司/] },
  { id: "mohrss", name: "人社部", patterns: [/人力资源和社会保障部|人力资源社会保障部|人社部/] },
  { id: "unesco", name: "联合国教科文组织", patterns: [/\bUNESCO\b|联合国教科文/] },
  { id: "tencent", name: "腾讯", patterns: [/腾讯|tencent/i] },
  { id: "baidu", name: "百度", patterns: [/百度|baidu/i] },
  { id: "aliyun", name: "阿里云", patterns: [/阿里云|阿里巴巴|\bali\b|钉钉|通义/i] },
  { id: "huawei", name: "华为", patterns: [/华为|huawei/i] },
  { id: "iflytek", name: "科大讯飞", patterns: [/科大讯飞|讯飞|iflytek/i] },
  { id: "xiandao", name: "新道科技", patterns: [/新道科技|新道/] },
  { id: "zhihuishu", name: "智慧树", patterns: [/智慧树/] },
  { id: "chaoxing", name: "超星", patterns: [/超星|学习通/] },
];

/** 这些域名上的文章，发布方就是对应的机构（托管平台不算）。 */
export const PUBLISHER_DOMAINS: ReadonlyArray<{ entityId: string; domains: readonly string[] }> = [
  { entityId: "moe", domains: ["moe.gov.cn"] },
  { entityId: "mohrss", domains: ["mohrss.gov.cn"] },
  { entityId: "tencent", domains: ["tencent.com"] },
  { entityId: "baidu", domains: ["baidu.com"] },
  { entityId: "aliyun", domains: ["aliyun.com", "alibaba.com"] },
  { entityId: "huawei", domains: ["huawei.com"] },
  { entityId: "iflytek", domains: ["iflytek.com"] },
];

/** 原文里的这些写法也算提到了对应机构。 */
export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{ entityId: string; pattern: RegExp }> = [
  { entityId: "moe", pattern: /微言教育/ },
  { entityId: "aliyun", pattern: /钉钉(?:教育)?/ },
];
