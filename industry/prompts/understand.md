{{> content-understanding}}

{{> rules-domain}}

{{> rules-anti-hallucination}}

{{> rules-self-contained-title}}

{{> rules-answer-first-summary}}

最终只返回 itemType、authorRole、tags、editorialJudgment、titleZh、summaryZh、notesZh 七个字段。notesZh 按原文信息用 emoji + 小标题整理，缺失分组省略，不得编造；无信息留空。答案前置只描述 summaryZh 的写法，不要增加 answer 字段。
