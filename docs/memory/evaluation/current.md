# Memory intent current

Anonymous pure-rule evaluation. No model/network or real user data. CPU time is not first-token latency.

```json
{
  "mode": "current",
  "baselineRef": "1c84c405f474292195197ba07b6fa443e38eb28d",
  "layer": "pure-rules",
  "samples": 200,
  "note": "Synthetic labels; lexical intent classification only. CPU time is not first-token latency. No model, network or user database accessed.",
  "all": {
    "count": 200,
    "tp": 134,
    "fp": 0,
    "fn": 6,
    "tn": 60,
    "precision": 1,
    "recall": 0.9571428571428572,
    "f1": 0.9781021897810218
  },
  "tune": {
    "count": 150,
    "tp": 105,
    "fp": 0,
    "fn": 0,
    "tn": 45,
    "precision": 1,
    "recall": 1,
    "f1": 1
  },
  "test": {
    "count": 50,
    "tp": 29,
    "fp": 0,
    "fn": 6,
    "tn": 15,
    "precision": 1,
    "recall": 0.8285714285714286,
    "f1": 0.90625
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
      "tp": 19,
      "fp": 0,
      "fn": 1,
      "tn": 0,
      "precision": 1,
      "recall": 0.95,
      "f1": 0.9743589743589743
    },
    "explicit-project": {
      "count": 20,
      "tp": 20,
      "fp": 0,
      "fn": 0,
      "tn": 0,
      "precision": 1,
      "recall": 1,
      "f1": 1
    },
    "implicit": {
      "count": 20,
      "tp": 19,
      "fp": 0,
      "fn": 1,
      "tn": 0,
      "precision": 1,
      "recall": 0.95,
      "f1": 0.9743589743589743
    },
    "personalized": {
      "count": 20,
      "tp": 20,
      "fp": 0,
      "fn": 0,
      "tn": 0,
      "precision": 1,
      "recall": 1,
      "f1": 1
    },
    "current-context": {
      "count": 20,
      "tp": 0,
      "fp": 0,
      "fn": 0,
      "tn": 20,
      "precision": 0,
      "recall": 0,
      "f1": 0
    },
    "distractors": {
      "count": 20,
      "tp": 0,
      "fp": 0,
      "fn": 0,
      "tn": 20,
      "precision": 0,
      "recall": 0,
      "f1": 0
    },
    "corrections": {
      "count": 20,
      "tp": 18,
      "fp": 0,
      "fn": 2,
      "tn": 0,
      "precision": 1,
      "recall": 0.9,
      "f1": 0.9473684210526316
    },
    "mixed-tools": {
      "count": 20,
      "tp": 20,
      "fp": 0,
      "fn": 0,
      "tn": 0,
      "precision": 1,
      "recall": 1,
      "f1": 1
    },
    "colloquial": {
      "count": 20,
      "tp": 18,
      "fp": 0,
      "fn": 2,
      "tn": 0,
      "precision": 1,
      "recall": 0.9,
      "f1": 0.9473684210526316
    }
  },
  "routing": {
    "all": {
      "count": 200,
      "tp": 134,
      "fp": 0,
      "fn": 6,
      "tn": 60,
      "precision": 1,
      "recall": 0.9571428571428572,
      "f1": 0.9781021897810218
    },
    "tune": {
      "count": 150,
      "tp": 105,
      "fp": 0,
      "fn": 0,
      "tn": 45,
      "precision": 1,
      "recall": 1,
      "f1": 1
    },
    "test": {
      "count": 50,
      "tp": 29,
      "fp": 0,
      "fn": 6,
      "tn": 15,
      "precision": 1,
      "recall": 0.8285714285714286,
      "f1": 0.90625
    },
    "classifierTriggerRate": 0,
    "disallowedClassifierRequests": [],
    "ruleDecisionRate": 1,
    "note": "Actual production route + trigger functions, with no model execution. Does not measure classifier accuracy or final routing after fallback."
  },
  "cpuMs": {
    "p50": 0.00190000000000623,
    "p95": 0.005400000000008731,
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
      "id": "implicit-20",
      "query": "我还是想走原先商量的路线",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "含隐含长期依赖，允许规则解决或一次语义兜底"
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
      "id": "corrections-20",
      "query": "先列出旧习惯，别直接覆盖",
      "split": "test",
      "needsMemory": true,
      "predicted": false,
      "reason": "明确比较或纠正已存事实，需查同作用域旧事实"
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
      "id": "colloquial-16",
      "query": "我平时啥风格",
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
