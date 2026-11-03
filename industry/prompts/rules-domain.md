【AI 与教育内容翻译规则 — 按原文语境消歧，不改造事实】

1. 词义由原文的技术、教学或制度语境决定，不能因为读者是教师就强行改成教育含义：
   - Agent（AI 技术语境）= 智能体；只有原文明示教学助理角色才译为智能助教。通用智能体不是已经落地的助教产品
   - Token / tokens（大模型语境）= 模型 token（保留英文；不译"代币"）；认证语境的 token 按实际含义译为令牌
   - Prompt（模型交互语境）= 提示词；Fine-tune（模型训练语境）= 微调
   - LLM（AI 语境）指大语言模型，缩写按下方规则保留，不译为"法学硕士"
   - Vocational = 职业的、职业教育的，按修饰对象选择
   - TVET 指职业教育与培训（UNESCO 语境），CTE（Career and Technical Education）指职业技术教育（美国语境）；缩写按下方规则保留
   - Apprenticeship = 学徒制；不擅自补成特定国家的现代学徒制政策
   - Credential / Certification 在技能与资质语境译为证书、认证；访问系统或 API 的 credential 译为凭据，不能改成技能证书
   - Assessment 在教学语境译为评价、考核，在模型能力、系统或风险语境按实际对象译为评估、测评；不能把技术评测改成学生成绩评价
   - Upskilling / Reskilling = 技能提升 / 再培训

2. 以下专有名词**一律保留英文原文**，不翻译不加中文括注：
   - 机构：UNESCO / WorldSkills / OECD / World Bank
   - 国际赛事与框架：WorldSkills Competition / EU Skills Agenda / EQF / QF / NVQ
   - 教育科技产品：ChatGPT / Copilot / Gemini / DeepSeek / Qwen / Coursera / Canvas / Moodle / Blackboard
   - 技术缩写（举例 + 通用规则）：AI / LLM / GPT / RAG / API / SDK / VR / AR / XR / GPU
     **规则**：任何 2-5 字母的全大写缩写，默认按原文保留英文
   - 基准与评测名：以 -bench / -eval 结尾或全大写的评测名一律保留英文

3. 中国机构与院校**优先用官方中文全称或通行简称**（首次出现可用全称，后续用通行简称保持一致）：
   - 教育部 / 教育部职业教育与成人教育司（职成司）/ 人力资源和社会保障部（人社部）
   - "双高计划"（中国特色高水平高职学校和专业建设计划）/ 职教高考 / 1+X 证书 / 双师型教师
   - 世界技能大赛 / 全国职业院校技能大赛 / 全国职业大学、职业技术学院等院校按其官网名称

4. 代码 / 命令 / URL / 数字单位 **一字不改**保留：
   - 反引号代码 `code` 不翻译
   - URL 原样
   - 数字+单位：8k context / 3.5x speedup / 99.9%
   - 金额、比例、区间必须保留原文的阿拉伯数字和单位；不要把 $10B 改写成"数十亿美元"等中文数量词
   - 文号照原文（教职成〔2026〕X 号），不简写不改写
