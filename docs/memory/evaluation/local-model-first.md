# Local light model evaluation

~~~json
{
  "model": "qwen3:0.6b-q8_0",
  "budget": 8,
  "calls": 8,
  "concurrency": 1,
  "timeoutMs": 3000,
  "adapter": "Installed Ollama CLI with serialized production classifier messages; not the desktop Rust HTTP proxy. No network credential or real user data used.",
  "note": "CLI first output includes process/model startup, not application first-token latency. Controls are additional calibration cases, not tuning samples.",
  "selected": 8,
  "classified": 0,
  "accuracyAmongClassified": null,
  "endToEnd": "NOT TESTED",
  "appFirstToken": "NOT TESTED",
  "results": [
    {
      "id": "implicit-04",
      "query": "继续沿用之前的格式",
      "expectedMemory": true,
      "predictedMemory": null,
      "status": "timeout",
      "correct": false,
      "elapsedMs": 3005.4767999999995,
      "cliFirstOutputMs": null,
      "usage": {
        "promptTokens": null,
        "completionTokens": null
      }
    },
    {
      "id": "implicit-14",
      "query": "按我之前的习惯制定计划",
      "expectedMemory": true,
      "predictedMemory": null,
      "status": "timeout",
      "correct": false,
      "elapsedMs": 3011.9844999999996,
      "cliFirstOutputMs": null,
      "usage": {
        "promptTokens": null,
        "completionTokens": null
      }
    },
    {
      "id": "implicit-15",
      "query": "之前那套规则继续执行",
      "expectedMemory": true,
      "predictedMemory": null,
      "status": "invalid",
      "correct": false,
      "elapsedMs": 2869.9318999999996,
      "cliFirstOutputMs": 2380.527899999999,
      "usage": {
        "promptTokens": 506,
        "completionTokens": 24
      }
    },
    {
      "id": "implicit-16",
      "query": "老样子就行，格式你知道",
      "expectedMemory": true,
      "predictedMemory": null,
      "status": "invalid",
      "correct": false,
      "elapsedMs": 2214.1558999999997,
      "cliFirstOutputMs": 1981.3029999999999,
      "usage": {
        "promptTokens": 506,
        "completionTokens": 12
      }
    },
    {
      "id": "control-lookup",
      "query": "这个说法靠谱吗？",
      "expectedMemory": false,
      "predictedMemory": null,
      "status": "invalid",
      "correct": false,
      "elapsedMs": 2463.700499999999,
      "cliFirstOutputMs": 1894.9488000000001,
      "usage": {
        "promptTokens": 505,
        "completionTokens": 27
      }
    },
    {
      "id": "control-source",
      "query": "那份材料的出处在哪？",
      "expectedMemory": false,
      "predictedMemory": null,
      "status": "invalid",
      "correct": false,
      "elapsedMs": 2606.8896000000004,
      "cliFirstOutputMs": 1998.7775999999994,
      "usage": {
        "promptTokens": 506,
        "completionTokens": 27
      }
    },
    {
      "id": "control-evidence",
      "query": "这句话的依据是什么？",
      "expectedMemory": false,
      "predictedMemory": null,
      "status": "invalid",
      "correct": false,
      "elapsedMs": 2622.0615000000034,
      "cliFirstOutputMs": 2064.2512000000024,
      "usage": {
        "promptTokens": 505,
        "completionTokens": 27
      }
    },
    {
      "id": "control-method",
      "query": "原来那个方法为什么不适用？",
      "expectedMemory": false,
      "predictedMemory": null,
      "status": "invalid",
      "correct": false,
      "elapsedMs": 2420.548899999998,
      "cliFirstOutputMs": 1927.5446999999986,
      "usage": {
        "promptTokens": 506,
        "completionTokens": 24
      }
    }
  ]
}
~~~
