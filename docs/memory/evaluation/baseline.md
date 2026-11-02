# Memory intent baseline

Anonymous pure-rule evaluation. No model/network or real user data. CPU time is not first-token latency.

```json
{
  "mode": "baseline",
  "baselineRef": "1c84c405f474292195197ba07b6fa443e38eb28d",
  "layer": "pure-rules",
  "samples": 200,
  "note": "Synthetic labels; lexical intent classification only. CPU time is not first-token latency. No model, network or user database accessed.",
  "all": {
    "count": 200,
    "tp": 48,
    "fp": 7,
    "fn": 92,
    "tn": 53,
    "precision": 0.8727272727272727,
    "recall": 0.34285714285714286,
    "f1": 0.49230769230769234
  },
  "tune": {
    "count": 150,
    "tp": 37,
    "fp": 4,
    "fn": 68,
    "tn": 41,
    "precision": 0.9024390243902439,
    "recall": 0.3523809523809524,
    "f1": 0.5068493150684932
  },
  "test": {
    "count": 50,
    "tp": 11,
    "fp": 3,
    "fn": 24,
    "tn": 12,
    "precision": 0.7857142857142857,
    "recall": 0.3142857142857143,
    "f1": 0.44897959183673464
  },
  "groups": {
    "general": {
      "count": 20,
      "tp": 0,
      "fp": 0,
      "fn": 0,
      "tn": 20,
      "precision": 0,
      "recall": 0,
      "f1": 0
    },
    "explicit-global": {
      "count": 20,
      "tp": 13,
      "fp": 0,
      "fn": 7,
      "tn": 0,
      "precision": 1,
      "recall": 0.65,
      "f1": 0.787878787878788
    },
    "explicit-project": {
      "count": 20,
      "tp": 6,
      "fp": 0,
      "fn": 14,
      "tn": 0,
      "precision": 1,
      "recall": 0.3,
      "f1": 0.4615384615384615
    },
    "implicit": {
      "count": 20,
      "tp": 11,
      "fp": 0,
      "fn": 9,
      "tn": 0,
      "precision": 1,
      "recall": 0.55,
      "f1": 0.7096774193548387
    },
    "personalized": {
      "count": 20,
      "tp": 8,
      "fp": 0,
      "fn": 12,
      "tn": 0,
      "precision": 1,
      "recall": 0.4,
      "f1": 0.5714285714285715
    },
    "current-context": {
      "count": 20,
      "tp": 0,
      "fp": 1,
      "fn": 0,
      "tn": 19,
      "precision": 0,
      "recall": 0,
      "f1": 0
    },
    "distractors": {
      "count": 20,
      "tp": 0,
      "fp": 6,
      "fn": 0,
      "tn": 14,
      "precision": 0,
      "recall": 0,
      "f1": 0
    },
    "corrections": {
      "count": 20,
      "tp": 2,
      "fp": 0,
      "fn": 18,
      "tn": 0,
      "precision": 1,
      "recall": 0.1,
      "f1": 0.18181818181818182
    },
    "mixed-tools": {
      "count": 20,
      "tp": 6,
      "fp": 0,
      "fn": 14,
      "tn": 0,
      "precision": 1,
      "recall": 0.3,
      "f1": 0.4615384615384615
    },
    "colloquial": {
      "count": 20,
      "tp": 2,
      "fp": 0,
      "fn": 18,
      "tn": 0,
      "precision": 1,
      "recall": 0.1,
      "f1": 0.18181818181818182
    }
  },
  "routing": {
    "all": {
      "count": 200,
      "tp": 48,
      "fp": 7,
      "fn": 92,
      "tn": 53,
      "precision": 0.8727272727272727,
      "recall": 0.34285714285714286,
      "f1": 0.49230769230769234
    },
    "tune": {
      "count": 150,
      "tp": 37,
      "fp": 4,
      "fn": 68,
      "tn": 41,
      "precision": 0.9024390243902439,
      "recall": 0.3523809523809524,
      "f1": 0.5068493150684932
    },
    "test": {
      "count": 50,
      "tp": 11,
      "fp": 3,
      "fn": 24,
      "tn": 12,
      "precision": 0.7857142857142857,
      "recall": 0.3142857142857143,
      "f1": 0.44897959183673464
    },
    "classifierTriggerRate": 0.12,
    "disallowedClassifierRequests": [
      "explicit-global-17",
      "explicit-project-05",
      "explicit-project-17"
    ],
    "ruleDecisionRate": 0.88,
    "note": "Actual production route + trigger functions, with no model execution. Does not measure classifier accuracy or final routing after fallback."
  },
  "cpuMs": {
    "p50": 0.001599999999996271,
    "p95": 0.0024999999999977263,
    "measurements": 20000
  },
  "failures": [
    {
      "id": "explicit-global-08",
      "query": "我通常用什么语言交流？",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确查询已告知的个人事实"
    },
    {
      "id": "explicit-global-09",
      "query": "查询我的输出格式偏好",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确查询已告知的个人事实"
    },
    {
      "id": "explicit-global-12",
      "query": "我的身份是什么来着",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确查询已告知的个人事实"
    },
    {
      "id": "explicit-global-13",
      "query": "我对饮食有什么禁忌，之前说过的",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确查询已告知的个人事实"
    },
    {
      "id": "explicit-global-14",
      "query": "检索我保存过的学习路线",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确查询已告知的个人事实"
    },
    {
      "id": "explicit-global-15",
      "query": "告诉我已经记住的个人背景",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确查询已告知的个人事实"
    },
    {
      "id": "explicit-global-17",
      "query": "我上次告诉你的职业是什么",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确查询已告知的个人事实"
    },
    {
      "id": "explicit-project-02",
      "query": "查看当前项目已经保存的规则",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确查询当前项目的长期约定或已知决定"
    },
    {
      "id": "explicit-project-04",
      "query": "项目里之前确定用哪个数据库？",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确查询当前项目的长期约定或已知决定"
    },
    {
      "id": "explicit-project-05",
      "query": "我们之前给这个项目定的发布规则是什么",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确查询当前项目的长期约定或已知决定"
    },
    {
      "id": "explicit-project-06",
      "query": "当前项目上次定下的接口边界还记得吗",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确查询当前项目的长期约定或已知决定"
    },
    {
      "id": "explicit-project-07",
      "query": "我保存过哪些工程约定",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确查询当前项目的长期约定或已知决定"
    },
    {
      "id": "explicit-project-09",
      "query": "这个项目当时为什么选 SQLite",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确查询当前项目的长期约定或已知决定"
    },
    {
      "id": "explicit-project-10",
      "query": "上次记录的架构决定是什么",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确查询当前项目的长期约定或已知决定"
    },
    {
      "id": "explicit-project-12",
      "query": "本项目默认使用什么测试框架，之前说过的",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确查询当前项目的长期约定或已知决定"
    },
    {
      "id": "explicit-project-14",
      "query": "之前确定的备份策略是什么",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确查询当前项目的长期约定或已知决定"
    },
    {
      "id": "explicit-project-16",
      "query": "项目里的打包方式当初怎么约定的",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确查询当前项目的长期约定或已知决定"
    },
    {
      "id": "explicit-project-17",
      "query": "我们之前决定放弃了哪个实现方案",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确查询当前项目的长期约定或已知决定"
    },
    {
      "id": "explicit-project-18",
      "query": "项目已经记住的长期目标有哪些",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确查询当前项目的长期约定或已知决定"
    },
    {
      "id": "explicit-project-19",
      "query": "回忆一下本项目的命名规范",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确查询当前项目的长期约定或已知决定"
    },
    {
      "id": "explicit-project-20",
      "query": "上次保存的发布窗口是哪一天",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确查询当前项目的长期约定或已知决定"
    },
    {
      "id": "implicit-11",
      "query": "接着上次定的长期目标来",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "含隐含长期依赖，允许规则解决或一次语义兜底"
    },
    {
      "id": "implicit-12",
      "query": "我之前提过的那个技术栈还有印象吗",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "含隐含长期依赖，允许规则解决或一次语义兜底"
    },
    {
      "id": "implicit-13",
      "query": "用我平时喜欢的表达来写",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "含隐含长期依赖，允许规则解决或一次语义兜底"
    },
    {
      "id": "implicit-14",
      "query": "按我之前的习惯制定计划",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "含隐含长期依赖，允许规则解决或一次语义兜底"
    },
    {
      "id": "implicit-16",
      "query": "老样子就行，格式你知道",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "含隐含长期依赖，允许规则解决或一次语义兜底"
    },
    {
      "id": "implicit-17",
      "query": "咱们原来定好的那份安排再看一下",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "含隐含长期依赖，允许规则解决或一次语义兜底"
    },
    {
      "id": "implicit-18",
      "query": "上回那个决定的原因还在吗",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "含隐含长期依赖，允许规则解决或一次语义兜底"
    },
    {
      "id": "implicit-19",
      "query": "按惯例处理这份材料",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "含隐含长期依赖，允许规则解决或一次语义兜底"
    },
    {
      "id": "implicit-20",
      "query": "我还是想走原先商量的路线",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "含隐含长期依赖，允许规则解决或一次语义兜底"
    },
    {
      "id": "personalized-03",
      "query": "翻译成我平时用的语气",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "任务依赖既有个人偏好而非泛用建议"
    },
    {
      "id": "personalized-06",
      "query": "根据我的背景推荐学习方向",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "任务依赖既有个人偏好而非泛用建议"
    },
    {
      "id": "personalized-08",
      "query": "考虑我的饮食偏好给个菜单",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "任务依赖既有个人偏好而非泛用建议"
    },
    {
      "id": "personalized-09",
      "query": "按照我之前说过的限制推荐运动",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "任务依赖既有个人偏好而非泛用建议"
    },
    {
      "id": "personalized-10",
      "query": "帮我规划适合我的职业路线，参考我的已有经历",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "任务依赖既有个人偏好而非泛用建议"
    },
    {
      "id": "personalized-13",
      "query": "根据你记住的我的专业安排课程",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "任务依赖既有个人偏好而非泛用建议"
    },
    {
      "id": "personalized-14",
      "query": "用我平时的文风写一段简介",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "任务依赖既有个人偏好而非泛用建议"
    },
    {
      "id": "personalized-15",
      "query": "按我之前的输出偏好给结论",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "任务依赖既有个人偏好而非泛用建议"
    },
    {
      "id": "personalized-16",
      "query": "参考我的学习进度，下一步学什么",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "任务依赖既有个人偏好而非泛用建议"
    },
    {
      "id": "personalized-17",
      "query": "按我常用的语言写说明",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "任务依赖既有个人偏好而非泛用建议"
    },
    {
      "id": "personalized-18",
      "query": "结合我的项目经历写个自我介绍",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "任务依赖既有个人偏好而非泛用建议"
    },
    {
      "id": "personalized-19",
      "query": "根据我存过的长期目标排优先级",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "任务依赖既有个人偏好而非泛用建议"
    },
    {
      "id": "current-context-13",
      "query": "沿用上文中明确给出的标题格式",
      "split": "tune",
      "needsMemory": false,
      "predicted": true,
      "reason": "近邻用户消息已完整提供答案，不必检索长期记忆"
    },
    {
      "id": "distractors-03",
      "query": "翻译：你还记得我吗",
      "split": "tune",
      "needsMemory": false,
      "predicted": true,
      "reason": "历史/记忆词属于待处理文本或一般概念"
    },
    {
      "id": "distractors-04",
      "query": "改写这句台词：你还记得我的地址吗",
      "split": "test",
      "needsMemory": false,
      "predicted": true,
      "reason": "历史/记忆词属于待处理文本或一般概念"
    },
    {
      "id": "distractors-08",
      "query": "解释浏览器 remember me 登录选项",
      "split": "test",
      "needsMemory": false,
      "predicted": true,
      "reason": "历史/记忆词属于待处理文本或一般概念"
    },
    {
      "id": "distractors-12",
      "query": "引用句“按我的风格写”有哪些语病",
      "split": "test",
      "needsMemory": false,
      "predicted": true,
      "reason": "历史/记忆词属于待处理文本或一般概念"
    },
    {
      "id": "distractors-17",
      "query": "不要查询我的记忆，直接说量子是什么",
      "split": "tune",
      "needsMemory": false,
      "predicted": true,
      "reason": "历史/记忆词属于待处理文本或一般概念"
    },
    {
      "id": "distractors-19",
      "query": "不要按我的习惯，按行业标准解释",
      "split": "tune",
      "needsMemory": false,
      "predicted": true,
      "reason": "历史/记忆词属于待处理文本或一般概念"
    },
    {
      "id": "corrections-01",
      "query": "我现在改用英文了，之前记的是什么？",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确比较或纠正已存事实，需查同作用域旧事实"
    },
    {
      "id": "corrections-02",
      "query": "我之前的技术栈是不是还记成 Vue 了？",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确比较或纠正已存事实，需查同作用域旧事实"
    },
    {
      "id": "corrections-03",
      "query": "我已经换城市了，你还记着旧地址吗",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确比较或纠正已存事实，需查同作用域旧事实"
    },
    {
      "id": "corrections-04",
      "query": "比较一下我新旧两版项目约定",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确比较或纠正已存事实，需查同作用域旧事实"
    },
    {
      "id": "corrections-05",
      "query": "旧的风格偏好是什么，我想改一下",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确比较或纠正已存事实，需查同作用域旧事实"
    },
    {
      "id": "corrections-07",
      "query": "之前保存的职业信息需要更新，先看看原来内容",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确比较或纠正已存事实，需查同作用域旧事实"
    },
    {
      "id": "corrections-08",
      "query": "我的学习进度是不是还停在上次那个章节",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确比较或纠正已存事实，需查同作用域旧事实"
    },
    {
      "id": "corrections-10",
      "query": "项目原来用的数据库记成什么了",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确比较或纠正已存事实，需查同作用域旧事实"
    },
    {
      "id": "corrections-11",
      "query": "检查已记住的规则里有没有过时的",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确比较或纠正已存事实，需查同作用域旧事实"
    },
    {
      "id": "corrections-12",
      "query": "我不再喜欢长回答了，旧偏好还有吗",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确比较或纠正已存事实，需查同作用域旧事实"
    },
    {
      "id": "corrections-13",
      "query": "回忆之前的决定，然后我们再改",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确比较或纠正已存事实，需查同作用域旧事实"
    },
    {
      "id": "corrections-14",
      "query": "查一下原来的部署约定，我想换方案",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确比较或纠正已存事实，需查同作用域旧事实"
    },
    {
      "id": "corrections-15",
      "query": "你记的语言偏好和我上次修改的一致吗",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确比较或纠正已存事实，需查同作用域旧事实"
    },
    {
      "id": "corrections-16",
      "query": "我已经毕业了，之前的身份记忆是什么",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确比较或纠正已存事实，需查同作用域旧事实"
    },
    {
      "id": "corrections-17",
      "query": "还记得旧项目边界吗，和新要求对照一下",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确比较或纠正已存事实，需查同作用域旧事实"
    },
    {
      "id": "corrections-18",
      "query": "把已保存的时间安排找出来，我需要改期",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确比较或纠正已存事实，需查同作用域旧事实"
    },
    {
      "id": "corrections-19",
      "query": "原来给我记录的目标是不是过时了",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确比较或纠正已存事实，需查同作用域旧事实"
    },
    {
      "id": "corrections-20",
      "query": "先列出旧习惯，别直接覆盖",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确比较或纠正已存事实，需查同作用域旧事实"
    },
    {
      "id": "mixed-tools-02",
      "query": "搜索资料并结合我的背景解释",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "记忆与资料/网络/编辑协同，仍须独立权限"
    },
    {
      "id": "mixed-tools-06",
      "query": "先查记忆中的技术栈，再搜索相关教程",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "记忆与资料/网络/编辑协同，仍须独立权限"
    },
    {
      "id": "mixed-tools-07",
      "query": "根据我之前的约定分析这份文件",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "记忆与资料/网络/编辑协同，仍须独立权限"
    },
    {
      "id": "mixed-tools-08",
      "query": "沿用我的输出习惯，搜索知识库给出答案",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "记忆与资料/网络/编辑协同，仍须独立权限"
    },
    {
      "id": "mixed-tools-10",
      "query": "回忆上次的决策，再查本地文档验证",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "记忆与资料/网络/编辑协同，仍须独立权限"
    },
    {
      "id": "mixed-tools-11",
      "query": "按已保存的学习路线找相关阅读成果",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "记忆与资料/网络/编辑协同，仍须独立权限"
    },
    {
      "id": "mixed-tools-13",
      "query": "参考我的工程边界，对知识库内容做审查",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "记忆与资料/网络/编辑协同，仍须独立权限"
    },
    {
      "id": "mixed-tools-14",
      "query": "基于我的身份给这些搜索结果排序",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "记忆与资料/网络/编辑协同，仍须独立权限"
    },
    {
      "id": "mixed-tools-15",
      "query": "用之前约定的格式总结当前文件",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "记忆与资料/网络/编辑协同，仍须独立权限"
    },
    {
      "id": "mixed-tools-16",
      "query": "先回忆决定，再给我一个提醒提案",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "记忆与资料/网络/编辑协同，仍须独立权限"
    },
    {
      "id": "mixed-tools-17",
      "query": "结合我平时的习惯和这份检索结果写建议",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "记忆与资料/网络/编辑协同，仍须独立权限"
    },
    {
      "id": "mixed-tools-18",
      "query": "把长期记忆中的旧结论与新资料做比较",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "记忆与资料/网络/编辑协同，仍须独立权限"
    },
    {
      "id": "mixed-tools-19",
      "query": "按我常用的方式归纳这些阅读成果",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "记忆与资料/网络/编辑协同，仍须独立权限"
    },
    {
      "id": "mixed-tools-20",
      "query": "根据我的项目背景研究一下这个主题",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "记忆与资料/网络/编辑协同，仍须独立权限"
    },
    {
      "id": "colloquial-02",
      "query": "俺之前说的习惯还在吗",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "短句口语或错字，明确个人/项目历史依赖"
    },
    {
      "id": "colloquial-03",
      "query": "老规距来一份",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "短句口语或错字，明确个人/项目历史依赖"
    },
    {
      "id": "colloquial-04",
      "query": "按我那套来呗",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "短句口语或错字，明确个人/项目历史依赖"
    },
    {
      "id": "colloquial-05",
      "query": "我啥专业来着，之前说过",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "短句口语或错字，明确个人/项目历史依赖"
    },
    {
      "id": "colloquial-06",
      "query": "咱上回咋定的",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "短句口语或错字，明确个人/项目历史依赖"
    },
    {
      "id": "colloquial-07",
      "query": "上次那事最后定了啥",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "短句口语或错字，明确个人/项目历史依赖"
    },
    {
      "id": "colloquial-08",
      "query": "我用啥技术栈你记得吧",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "短句口语或错字，明确个人/项目历史依赖"
    },
    {
      "id": "colloquial-09",
      "query": "我之前的偏好再说一遍",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "短句口语或错字，明确个人/项目历史依赖"
    },
    {
      "id": "colloquial-10",
      "query": "照咱原先讲好的整",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "短句口语或错字，明确个人/项目历史依赖"
    },
    {
      "id": "colloquial-12",
      "query": "我那个长期目标是啥",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "短句口语或错字，明确个人/项目历史依赖"
    },
    {
      "id": "colloquial-13",
      "query": "我喜欢啥格式你知道的",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "短句口语或错字，明确个人/项目历史依赖"
    },
    {
      "id": "colloquial-14",
      "query": "按之前约好的弄一下",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "短句口语或错字，明确个人/项目历史依赖"
    },
    {
      "id": "colloquial-15",
      "query": "我不是说过住哪吗，帮我回忆下",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "短句口语或错字，明确个人/项目历史依赖"
    },
    {
      "id": "colloquial-16",
      "query": "我平时啥风格",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "短句口语或错字，明确个人/项目历史依赖"
    },
    {
      "id": "colloquial-17",
      "query": "俺的学习进度呢",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "短句口语或错字，明确个人/项目历史依赖"
    },
    {
      "id": "colloquial-18",
      "query": "咱之前选的那套架构呢",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "短句口语或错字，明确个人/项目历史依赖"
    },
    {
      "id": "colloquial-19",
      "query": "我上回为啥没选另一方案",
      "split": "tune",
      "needsMemory": true,
      "predicted": false,
      "reason": "短句口语或错字，明确个人/项目历史依赖"
    },
    {
      "id": "colloquial-20",
      "query": "之前那约定，别忘了哈",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "短句口语或错字，明确个人/项目历史依赖"
    }
  ],
  "realModel": "NOT TESTED",
  "retrieval": "NOT TESTED",
  "finalAnswer": "NOT TESTED",
  "firstToken": "NOT TESTED"
}
```
