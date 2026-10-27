# AI 与选区契约

涉及 `src/services/rag/semanticChunker.ts`、`read_selection_context`、AI 路由、检索、长期记忆触发或 Agent 事件时，修改前必须读取本文件。

## 选区语义上下文

- RAG 索引与 `read_selection_context` 共用 `src/services/rag/semanticChunker.ts` 的 AST 语义原子。
- `read_selection_context` 只接受本轮 selection 授权，只返回包含 `role`、`headingPath`、`content` 的 `chunks` 数组。
- `direction=auto` 按相关性读取；`before/after/both` 是方向硬约束，按文档顺序读取，不得让另一方向参与预算竞争。
- Markdown 标题选区必须锚定该标题正文；`direction=after` 的范围包含其子标题，并在下一个同级或更高级标题前停止。
- Level 1 总预算为 700 tokens；仅在信息不足时调用 Level 2，将累计预算扩展到 1400 tokens，且只返回新增语义原子。
- 同一轮禁止跳级、重复读取同一层或自动升级为全文读取。

## AI 回答与检索触发

- 普通问答和简单解释按问题复杂度直接回答，不强制分段；总结、研究、Web 对照或复杂多步骤问题才使用结构化输出。
- 仅要求“翻译”本轮 selection 时必须走非 Agent 直答流程，只输出译文，不生成修改确认卡片，也不得替换原文。
- 只有用户明确要求“翻译并替换原文”、写回或修改原文时，翻译才按文档修改处理；必须携带本轮 selection/file tag，并继续经过修改确认卡片。
- 助手消息只有实际使用本地或 Web 资料时才展示来源；普通无来源回答不展示来源占位。
- 明确的主题研究、调研或归纳可直接检索全库 `search_knowledge`，无需 tag；指定文件总结仍需 file tag，任何文档改写仍需本轮 selection/file tag 和确认卡片。
- 只有要求沿用用户既有风格、语气、格式或习惯的改写才轻量检索 `preference/instruction` 长期记忆；普通改写不检索记忆。
- 手动保存沿用 1.2 秒 RAG 索引延迟，自动保存使用 5 秒索引防抖；同一文件的重复任务必须继续合并。
- Agent 执行入口使用单一 `AgentRunRequest` 对象；外部工具事件必须先经 `agent/session.ts` 运行时解码，再写入聊天 store。
- Agent 开启流式输出时，执行层必须把当前模型响应的累计文本实时传给聊天 UI；同批次包含多个工具调用时，每个工具都必须分别发送带 `toolName` 的 `action` 与 `observation` 事件。

## 本轮 MCP 工具选择

- `AiPanel` 持有显式选择，`McpToolPicker` 仅在用户打开时列出 Rust 返回的已启用、已连接服务，只有用户选择服务后才读取对应目录；不启动或自动连接服务，不轮询。关闭/卸载/开始发送后忽略迟到目录结果；刷新目录前撤销该服务旧选择，重新打开选择器清空旧选择。
- `useAiChat.sendMessage` 第六个可选参数传递 `McpTurnSnapshot`，在任何异步准备前复制；`requestBuilder` 再复制到可选 `AgentRunRequest.mcpTools`。每项固定 `serverId/connectionId/catalogRevision/remoteName/modelTool`（包含原目录 alias 与完整 Schema），最多16工具、8服务、64 KiB UTF-8。快照深复制冻结，不进入 chat tags、历史、数据库或全局 registry；发送后清空，重试不继承。
- 连接、目录与授权真相仍在 Rust。快照不能代替执行前连接/revision 校验或原生确认，不得按新目录解释旧 alias，不得扩大内置 `AgentToolName` 联合。外部描述和结果不作为系统指令或长期记忆。
- `runAgent` 再次复制本轮快照，完整模型声明只进入 tools，不把外部描述拼入系统提示；原生 toolCalls（含流式增量）与 JSON fallback 均按本轮 alias 白名单解析，未选择的 alias 拒绝。MCP 使用专属执行分支，不进入 primitive validator、全局 registry、内置读取并发/缓存或补调链。
- 外部调用逐项串行，先 prepare 再 confirm，由 Rust 原生确认及核验原连接/revision/精确工具名/原参数。绑定本轮 signal；取消 prepare 后迟到提案仍撤销，取消 confirm 后迟到成功不恢复本轮。同 alias/同规范化参数每轮最多一次；不同参数需独立确认。失败、isError、拒绝、取消及 outcome unknown 停止当前批次，不自动重试，也不让模型再发起修复调用。确认后目录/会话变化可能发生在执行后，保守展示结果未知，不能声称回滚。
- 外部结果保留 isError 并使用 `external_mcp_result` JSON 封套，超长正文截断但状态保留；仅作为明确标记的不可信 user 工具数据进入模型。`AgentStep.externalMcp` 标识目标与 success/error/outcome_unknown，session 不将 MCP observation 解码为内部修改/行动提案，来源 fallback 不采集 MCP。MCP 轮次排除 `save_memory`；现行自动候选提取只读取最新可见用户消息，不读取工具输出或助手回答。快照和外部原始结果不持久化为工具授权或长期记忆。
- 阶段3C实现与机器结果不替代 Windows 主应用和真实模型验收；未执行的原生确认、取消/撤销及真实服务端组合仍须标记 NOT TESTED。
