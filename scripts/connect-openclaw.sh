#!/usr/bin/env bash
# 把 OpenClaw 的 OTel 观测数据接到 machora
#
# 前提：
#   1) machora standalone 已启动（默认 http://localhost:3100）
#   2) 在"启动 OpenClaw 的同一终端"里执行：source scripts/connect-openclaw.sh
#
# OpenClaw 原生支持 OTel 全链路追踪（OTLP），配好 OTEL_* 环境变量即可，
# 无需改业务代码。machora 端点：POST /api/public/otel/v1/traces（OTLP JSON）

set -euo pipefail

MACHORA_URL="${MACHORA_URL:-http://localhost:3100}"
MACHORA_PUBLIC_KEY="${MACHORA_PUBLIC_KEY:-pk-machora-dev-000000000000000000000}"
MACHORA_SECRET_KEY="${MACHORA_SECRET_KEY:-sk-machora-dev-000000000000000000000}"

# 0) 探活
if ! curl -sf "$MACHORA_URL/api/public/health" >/dev/null; then
  echo "[machora] 服务不可达：$MACHORA_URL（先启动 standalone: pnpm standalone:dev）" >&2
  exit 1
fi

AUTH_B64="$(printf '%s:%s' "$MACHORA_PUBLIC_KEY" "$MACHORA_SECRET_KEY" | base64 | tr -d '\n')"

# 1) OTel 导出配置（OpenClaw 自动携带）
#    OpenClaw 的 diagnostics-otel 仅支持 http/protobuf（设置其他协议会跳过导出），
#    machora 端已支持 OTLP protobuf 解码（application/x-protobuf）。
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="$MACHORA_URL/api/public/otel"
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Basic $AUTH_B64"
export OTEL_SERVICE_NAME="${OTEL_SERVICE_NAME:-openclaw}"

echo "[machora] OpenClaw OTel 已指向 $MACHORA_URL/api/public/otel/v1/traces"
echo "[machora] service.name = $OTEL_SERVICE_NAME"
echo "[machora] 启动 OpenClaw 后，每次 agent 运行都会作为 trace 出现在 UI"
