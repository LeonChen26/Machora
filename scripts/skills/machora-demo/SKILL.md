---
name: machora-demo
description: "machora 集成验证用 skill：当被要求演示 skill 调用时，生成一个包含项目名、时间和一句问候的问候语。"
---

# machora-demo

当用户要求演示 skill 调用时使用本 skill。输出格式：

1. 先运行 `get_time`（MCP）获取当前时间
2. 然后用 `echo`（MCP）回显一句问候
3. 最后输出一句中文总结：`[machora-demo] 问候已生成 @ <时间>`

不要执行其他操作。
