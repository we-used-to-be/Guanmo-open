# Local light model evaluation

~~~json
{
  "model": "qwen3:0.6b-q8_0",
  "budget": 4,
  "calls": 4,
  "warmup": {
    "elapsedMs": 2489.5397000000003,
    "status": "completed"
  },
  "concurrency": 1,
  "timeoutMs": 3000,
  "adapter": "Installed Ollama CLI with serialized production classifier messages; not the desktop Rust HTTP proxy. No network credential or real user data used.",
  "note": "CLI first output includes process/model startup, not application first-token latency. Controls are additional calibration cases, not tuning samples.",
  "selected": 3,
  "classified": 0,
  "accuracyAmongClassified": null,
  "endToEnd": "NOT TESTED",
  "appFirstToken": "NOT TESTED",
  "results": [
    {
      "id": "control-lookup",
      "query": "这个说法靠谱吗？",
      "expectedMemory": false,
      "predictedMemory": null,
      "status": "timeout",
      "correct": false,
      "elapsedMs": 3008.3014,
      "cliFirstOutputMs": null,
      "usage": {
        "promptTokens": null,
        "completionTokens": null
      }
    },
    {
      "id": "control-source",
      "query": "那份材料的出处在哪？",
      "expectedMemory": false,
      "predictedMemory": null,
      "status": "invalid",
      "correct": false,
      "elapsedMs": 2679.4381999999996,
      "cliFirstOutputMs": 2075.312500000001,
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
      "elapsedMs": 2678.004799999999,
      "cliFirstOutputMs": 2095.645199999999,
      "usage": {
        "promptTokens": 505,
        "completionTokens": 27
      }
    }
  ]
}
~~~
