"""machora.* 语义键常量（与 packages/shared/src/otel/semantics/machora.ts 对齐）。

探针直接上报 machora.* 键，接入层 machora adapter（priority 10）归一化后
machora.span.kind 直接落库 observation.type。
"""

# 角色 / 操作
SPAN_KIND = "machora.span.kind"
OPERATION = "machora.operation"

# trace 级字段（根 span 携带，接入层提升到 trace 表）
TRACE_NAME = "machora.trace.name"
USER_ID = "machora.user.id"
SESSION_ID = "machora.session.id"
AGENT_NAME = "machora.agent.name"
WORKFLOW_NAME = "machora.workflow.name"
SKILL_NAME = "machora.skill.name"
TAGS = "machora.tags"

# observation 级字段
MODEL_NAME = "machora.model.name"
TOOL_NAME = "machora.tool.name"
TOOL_CALL_ID = "machora.tool.call.id"
INPUT = "machora.input"  # JSON 字符串或对象
OUTPUT = "machora.output"
TOKEN_INPUT = "machora.token.input"
TOKEN_OUTPUT = "machora.token.output"
TOKEN_TOTAL = "machora.token.total"
LEVEL = "machora.level"

# machora.span.kind 取值（与接入层 MACHORA_SPAN_KINDS 一致）
KIND_ENTRY = "ENTRY"  # 顶层执行入口（根）
KIND_AGENT = "AGENT"  # agent 本体运行
KIND_STEP = "STEP"  # ReAct 单轮 / 图节点
KIND_CHAIN = "CHAIN"  # 工作流 / 子链
KIND_LLM = "LLM"
KIND_TOOL = "TOOL"
KIND_EMBEDDING = "EMBEDDING"
KIND_RETRIEVER = "RETRIEVER"
KIND_RERANKER = "RERANKER"
KIND_EVENT = "EVENT"
