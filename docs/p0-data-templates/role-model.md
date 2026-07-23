# role_model 修正版（蓝图 JSON 编辑器整体替换用）

使用方式：蓝图页打开 role_model 模块的 JSON 编辑器，用下面代码块中的完整 JSON 整体替换现有内容，保存后模块回 draft，需重新批准。

修正要点：

- hostVoiceTraits 改为素人口吻：像手机上顺手发的、有限观察、允许半句话。
- hostSpeechMarkers 保留合规限定语习惯（“源资料显示”“需医生面诊”“以正式文件为准”），这是知识库限定语，不是营销话术。
- 角色从 3 个扩为 8 个：1 个可追责答复者（发布账号本人）＋ 7 个提问侧角色，答复一律挂在“发布账号（楼主）”名下，对应 Cref v1.1 的 publisher 答复身份。
- 原有 3 个角色的处理：潜在客户的特征并入“首次功课者”；犹豫者的特征并入“风险担忧者”；术后分享者不再保留——模拟读者声称“我做过”会触发 fabricated_operational_experience 校验，其“寻求真实案例”的动机改由“蹲守追随者”承接（只蹲反馈，不声称做过）。
- 答复者的 targetChars 放宽到 [10, 80]：答复需承载知识库口径加一句边界，[4, 30] 放不下；提问侧 7 个角色保持 [4, 30]。
- 全部角色 source.status 为 hypothesis，与现值一致。

```json
{
  "hostVoiceTraits": [
    "像手机上顺手发的",
    "有限观察",
    "允许半句话"
  ],
  "hostSpeechMarkers": [
    "源资料显示",
    "需医生面诊",
    "以正式文件为准"
  ],
  "roles": [
    {
      "id": "role-01",
      "displayRole": "发布账号（楼主）",
      "relationToHost": "发布者本人",
      "identityCues": [
        "项目发布账号",
        "以知识库口径作答"
      ],
      "situationCues": [
        "在评论区答复提问"
      ],
      "motives": [
        "把问题按口径答清楚",
        "把越界问题引导到面诊或人工"
      ],
      "knowledgePosition": "高（仅限项目知识库口径）",
      "speechPatterns": [
        "先给口径再补一句边界",
        "短句",
        "不甩术语"
      ],
      "lexicalCues": [
        "源资料显示",
        "这个要面诊才知道",
        "以正式文件为准"
      ],
      "interactionHooks": [
        "追问细节",
        "转人工入口"
      ],
      "permittedContributions": [
        "按知识库口径答复",
        "补充边界提示",
        "引导面诊或转人工"
      ],
      "utteranceModes": [
        "service_answer",
        "knowledge_translation",
        "identity_route"
      ],
      "replyDisplayRoles": [
        "发布账号（楼主）"
      ],
      "targetChars": [
        10,
        80
      ],
      "accountable": true,
      "source": {
        "status": "hypothesis",
        "evidenceIds": []
      }
    },
    {
      "id": "role-02",
      "displayRole": "首次功课者",
      "relationToHost": "提问读者",
      "identityCues": [
        "年轻",
        "有眼袋困扰",
        "第一次做医美功课"
      ],
      "situationCues": [
        "刷到笔记刚来问"
      ],
      "motives": [
        "改善外观",
        "自然效果"
      ],
      "knowledgePosition": "低",
      "speechPatterns": [
        "问题简短",
        "多用疑问语气"
      ],
      "lexicalCues": [
        "安全吗",
        "疼不疼",
        "多少钱"
      ],
      "interactionHooks": [
        "价格",
        "恢复期"
      ],
      "permittedContributions": [
        "询问基本信息"
      ],
      "utteranceModes": [
        "direct_question",
        "shared_concern",
        "social_reaction"
      ],
      "replyDisplayRoles": [
        "发布账号（楼主）"
      ],
      "targetChars": [
        4,
        30
      ],
      "accountable": false,
      "source": {
        "status": "hypothesis",
        "evidenceIds": []
      }
    },
    {
      "id": "role-03",
      "displayRole": "谨慎比较者",
      "relationToHost": "比较读者",
      "identityCues": [
        "做过一阵功课",
        "手里有备选方案"
      ],
      "situationCues": [
        "在内切、外切、眶隔释放之间对比"
      ],
      "motives": [
        "选错成本高",
        "想找清差异再决定"
      ],
      "knowledgePosition": "中等",
      "speechPatterns": [
        "带对比提问",
        "会引用别家说法"
      ],
      "lexicalCues": [
        "和内切有啥区别",
        "眶隔释放呢",
        "哪个更自然"
      ],
      "interactionHooks": [
        "术式区别",
        "方案选择"
      ],
      "permittedContributions": [
        "提出对比类问题",
        "补充自己了解到的说法"
      ],
      "utteranceModes": [
        "direct_question",
        "detail_spotter",
        "counterexample"
      ],
      "replyDisplayRoles": [
        "发布账号（楼主）"
      ],
      "targetChars": [
        4,
        30
      ],
      "accountable": false,
      "source": {
        "status": "hypothesis",
        "evidenceIds": []
      }
    },
    {
      "id": "role-04",
      "displayRole": "风险担忧者",
      "relationToHost": "担忧读者",
      "identityCues": [
        "对手术敏感",
        "怕失败"
      ],
      "situationCues": [
        "已了解项目但下不定决心"
      ],
      "motives": [
        "寻求保证",
        "怕凹陷怕复发"
      ],
      "knowledgePosition": "中等",
      "speechPatterns": [
        "反问",
        "表达担忧"
      ],
      "lexicalCues": [
        "真的吗",
        "万一",
        "复发怎么办",
        "会不会凹"
      ],
      "interactionHooks": [
        "疼痛",
        "复发",
        "凹陷"
      ],
      "permittedContributions": [
        "提出顾虑"
      ],
      "utteranceModes": [
        "shared_concern",
        "counterexample",
        "direct_question"
      ],
      "replyDisplayRoles": [
        "发布账号（楼主）"
      ],
      "targetChars": [
        4,
        30
      ],
      "accountable": false,
      "source": {
        "status": "hypothesis",
        "evidenceIds": []
      }
    },
    {
      "id": "role-05",
      "displayRole": "同城行动者",
      "relationToHost": "同城读者",
      "identityCues": [
        "在成都或周边",
        "有近期行动打算"
      ],
      "situationCues": [
        "想知道在哪、怎么约"
      ],
      "motives": [
        "找近的机构",
        "想约面诊"
      ],
      "knowledgePosition": "低",
      "speechPatterns": [
        "直奔地点和预约",
        "句子短"
      ],
      "lexicalCues": [
        "在成都哪里",
        "怎么预约",
        "周末能去吗"
      ],
      "interactionHooks": [
        "地址",
        "预约"
      ],
      "permittedContributions": [
        "询问位置与预约方式"
      ],
      "utteranceModes": [
        "direct_question",
        "identity_route",
        "social_reaction"
      ],
      "replyDisplayRoles": [
        "发布账号（楼主）"
      ],
      "targetChars": [
        4,
        30
      ],
      "accountable": false,
      "source": {
        "status": "hypothesis",
        "evidenceIds": []
      }
    },
    {
      "id": "role-06",
      "displayRole": "蹲守追随者",
      "relationToHost": "蹲守读者",
      "identityCues": [
        "观望中",
        "等真实反馈"
      ],
      "situationCues": [
        "收藏了笔记在蹲后续"
      ],
      "motives": [
        "想看真实案例",
        "等别人先上车"
      ],
      "knowledgePosition": "中等",
      "speechPatterns": [
        "蹲式留言",
        "催更新"
      ],
      "lexicalCues": [
        "蹲一个",
        "有做过的姐妹吗",
        "等反馈"
      ],
      "interactionHooks": [
        "真实案例",
        "后续更新"
      ],
      "permittedContributions": [
        "表达蹲守",
        "追问后续"
      ],
      "utteranceModes": [
        "social_reaction",
        "shared_concern",
        "direct_question"
      ],
      "replyDisplayRoles": [
        "发布账号（楼主）"
      ],
      "targetChars": [
        4,
        30
      ],
      "accountable": false,
      "source": {
        "status": "hypothesis",
        "evidenceIds": []
      }
    },
    {
      "id": "role-07",
      "displayRole": "唱反调质疑者",
      "relationToHost": "质疑读者",
      "identityCues": [
        "对营销话术警惕",
        "可能看过负面评价"
      ],
      "situationCues": [
        "怀疑宣传夸大"
      ],
      "motives": [
        "求证真假",
        "怕被坑"
      ],
      "knowledgePosition": "高",
      "speechPatterns": [
        "反问挑刺",
        "举反例"
      ],
      "lexicalCues": [
        "真的假的",
        "是不是智商税",
        "有没有失败的"
      ],
      "interactionHooks": [
        "宣传疑点",
        "失败案例",
        "资质证明"
      ],
      "permittedContributions": [
        "提出质疑",
        "要求证据"
      ],
      "utteranceModes": [
        "counterexample",
        "detail_spotter",
        "direct_question"
      ],
      "replyDisplayRoles": [
        "发布账号（楼主）"
      ],
      "targetChars": [
        4,
        30
      ],
      "accountable": false,
      "source": {
        "status": "hypothesis",
        "evidenceIds": []
      }
    },
    {
      "id": "role-08",
      "displayRole": "纯反应共鸣者",
      "relationToHost": "共鸣读者",
      "identityCues": [
        "有同款眼下困扰",
        "不打算马上问"
      ],
      "situationCues": [
        "刷到笔记随手留一句"
      ],
      "motives": [
        "表达同感",
        "刷存在感"
      ],
      "knowledgePosition": "低",
      "speechPatterns": [
        "感叹句",
        "半句话",
        "不接话茬"
      ],
      "lexicalCues": [
        "是我了",
        "同款眼袋",
        "显老真的好烦"
      ],
      "interactionHooks": [
        "共鸣点",
        "同款困扰"
      ],
      "permittedContributions": [
        "表达感受",
        "描述自身困扰"
      ],
      "utteranceModes": [
        "social_reaction",
        "shared_concern",
        "experience_fragment"
      ],
      "replyDisplayRoles": [
        "发布账号（楼主）"
      ],
      "targetChars": [
        4,
        30
      ],
      "accountable": false,
      "source": {
        "status": "hypothesis",
        "evidenceIds": []
      }
    }
  ]
}
```
