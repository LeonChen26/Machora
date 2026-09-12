# ============================================================================
# Machora API 全量验证脚本
# 用法（本地）：
#   powershell -ExecutionPolicy Bypass -File scripts\verify-api.ps1
# 用法（云端）：
#   powershell -ExecutionPolicy Bypass -File scripts\verify-api.ps1 -BaseUrl http://115.190.236.156
#
# 所有端点均为公开，无需鉴权。
#
# 覆盖端点（全部）：
#   GET  /api/public/health
#   GET  /api/public/traces?limit
#   GET  /api/public/traces/{id}
#   GET  /api/public/observations?limit
#   GET  /api/public/observations/{id}
#   GET  /api/public/scores?limit
#   GET  /api/public/evaluations?limit
#   GET  /api/public/evaluations/{id}
#   POST /api/public/otel/v1/traces   (OTLP JSON)
#   POST /api/public/otel/v1/metrics  (OTLP JSON)
#   POST /api/public/scores           (annotation)
#   POST /api/public/evaluations      (异步评估任务)
#   GET  /api/export/traces           (CSV)
#   GET  /api/export/generations      (CSV)
#   POST /api/scores                  (UI 标注)
#   [负向] 不存在 404 / 坏 payload 400
# ============================================================================

param(
  [string]$BaseUrl = "http://localhost:3100"
)

$ErrorActionPreference = "Stop"
$script:Pass = 0
$script:Fail = 0
$script:Log = New-Object System.Collections.Generic.List[string]

function Write-Step([string]$msg) { Write-Host ""; Write-Host "===== $msg =====" -ForegroundColor Cyan }

function Check([string]$name, [bool]$ok, [string]$detail = "") {
  if ($ok) { $script:Pass++; Write-Host "  [PASS] $name" -ForegroundColor Green }
  else     { $script:Fail++; Write-Host "  [FAIL] $name  $detail" -ForegroundColor Red }
  $script:Log.Add("$name=$ok $detail")
}

# ---- HTTP 帮助（PS5.1 兼容：4xx/5xx 抛异常，统一转成 {status, body}） ----
function Invoke-Api {
  param(
    [string]$Method,
    [string]$Path,
    [string]$Body = "",
    [string]$ContentType = "application/json",
    [Microsoft.PowerShell.Commands.WebRequestSession]$Session = $null
  )
  $psArgs = @{ Uri = "$BaseUrl$Path"; Method = $Method; ContentType = $ContentType; TimeoutSec = 30 }
  if ($Body) { $psArgs["Body"] = $Body }
  if ($Session) { $psArgs["WebSession"] = $Session }
  try {
    $r = Invoke-WebRequest @psArgs -UseBasicParsing
    return @{ Status = [int]$r.StatusCode; Body = $r.Content }
  } catch {
    $status = 0
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    return @{ Status = $status; Body = "" }
  }
}

Write-Host "======================================================"
Write-Host "  Machora API 验证  BaseUrl=$BaseUrl"
Write-Host "======================================================"

$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
# 主键取自 OTLP 通道：processor 直接用 OTLP traceId / spanId 作 trace.id / observation.id
# （见 packages/shared/src/otel/processor.ts 的 TraceRecord.id / ObservationRecord.id）
# 下方 B1 的 OTLP 请求即用这两个值，C/D/E 段据此读回与关联评分/评估。
$traceId = "0000000000000000000000000000000$stamp"
$obsId = "0000000000000001"
$nowNano = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString() + "000000"

# ============================================================================
Write-Step "A. 公开只读 API"
# ============================================================================

$r = Invoke-Api -Method GET -Path "/api/public/health"
Check "health 200" ($r.Status -eq 200) "status=$($r.Status)"

$r = Invoke-Api -Method GET -Path "/api/public/traces?limit=5"
Check "traces list 200" ($r.Status -eq 200) "status=$($r.Status)"

$r = Invoke-Api -Method GET -Path "/api/public/observations?limit=5"
Check "observations list 200" ($r.Status -eq 200) "status=$($r.Status)"

$r = Invoke-Api -Method GET -Path "/api/public/scores?limit=5"
Check "scores list 200" ($r.Status -eq 200) "status=$($r.Status)"

$r = Invoke-Api -Method GET -Path "/api/public/evaluations?limit=5"
Check "evaluations list 200" ($r.Status -eq 200) "status=$($r.Status)"

# ============================================================================
Write-Step "B. 注入 API（OTLP traces + OTLP metrics）"
# ============================================================================

# B1. /api/public/otel/v1/traces —— OTLP JSON 通道
$otelTraceBody = @{
  resourceSpans = @(
    @{
      resource = @{ attributes = @(@{ key = "service.name"; value = @{ stringValue = "verify-otel" } }) }
      scopeSpans = @(
        @{
          scope = @{}
          spans = @(
            @{
              traceId = $traceId
              spanId = $obsId
              parentSpanId = ""
              name = "verify-otel-span"
              kind = 2
              startTimeUnixNano = $nowNano
              endTimeUnixNano = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 1).ToString() + "000000"
              attributes = @(@{ key = "x"; value = @{ stringValue = "y" } })
            }
          )
        }
      )
    }
  )
} | ConvertTo-Json -Depth 20
$r = Invoke-Api -Method POST -Path "/api/public/otel/v1/traces" -Body $otelTraceBody
$ok = $r.Status -eq 200 -and $r.Body -match '"success":true' -and $r.Body -match '"traces":1'
Check "OTLP traces 注入 200" $ok "status=$($r.Status) body=$($r.Body)"

# B2. /api/public/otel/v1/metrics —— OTLP JSON gauge
$otelMetricBody = @{
  resourceMetrics = @(
    @{
      resource = @{ attributes = @(@{ key = "service.name"; value = @{ stringValue = "verify-otel" } }) }
      scopeMetrics = @(
        @{
          metrics = @(
            @{
              name = "verify.metric.gauge"
              unit = "1"
              gauge = @{ dataPoints = @(@{ asDouble = 42.5; timeUnixNano = $nowNano; attributes = @(@{ key = "k"; value = @{ stringValue = "v" } }) }) }
            }
          )
        }
      )
    }
  )
} | ConvertTo-Json -Depth 20
$r = Invoke-Api -Method POST -Path "/api/public/otel/v1/metrics" -Body $otelMetricBody
$ok = $r.Status -eq 200 -and $r.Body -match '"success":true' -and $r.Body -match '"metrics":1'
Check "OTLP metrics 注入 200" $ok "status=$($r.Status) body=$($r.Body)"

# ============================================================================
Write-Step "C. 详情查询（读回刚写入的数据）"
# ============================================================================

$r = Invoke-Api -Method GET -Path "/api/public/traces/$traceId"
Check "traces/{id} 200 且 name 匹配" ($r.Status -eq 200 -and $r.Body -match "verify-otel-span") "status=$($r.Status)"

$r = Invoke-Api -Method GET -Path "/api/public/observations/$obsId"
Check "observations/{id} 200" ($r.Status -eq 200) "status=$($r.Status)"

$r = Invoke-Api -Method GET -Path "/api/public/traces?name=verify-otel-span"
Check "traces?name 过滤（OTLP 链路）" ($r.Status -eq 200 -and $r.Body -match "verify-otel") "status=$($r.Status)"

# ============================================================================
Write-Step "D. 标注 + 评估（public scores POST / evaluations POST）"
# ============================================================================

# D1. POST /api/public/scores —— annotation 提交
$scoreBody = @{ traceId = $traceId; name = "verify-annotation"; value = 1; dataType = "BOOLEAN"; comment = "verify" } | ConvertTo-Json
$r = Invoke-Api -Method POST -Path "/api/public/scores" -Body $scoreBody
Check "public scores POST 201" ($r.Status -eq 201) "status=$($r.Status) body=$($r.Body)"

# 评分写回后，按 traceId 过滤应能查到（原先依赖已移除的 ingestion 预置评分）
$r = Invoke-Api -Method GET -Path "/api/public/scores?traceId=$traceId"
Check "scores?traceId 过滤" ($r.Status -eq 200 -and $r.Body -match '"totalCount":[1-9]') "status=$($r.Status) body=$($r.Body)"

# D2. POST /api/public/evaluations —— 异步评估任务（内置 error 评估器）
$evalBody = @{ traceId = $traceId; name = "verify-eval"; evaluatorType = "error" } | ConvertTo-Json
$r = Invoke-Api -Method POST -Path "/api/public/evaluations" -Body $evalBody
Check "evaluations POST 201" ($r.Status -eq 201) "status=$($r.Status) body=$($r.Body)"
$evalId = ""
if ($r.Status -eq 201) { $evalId = ([regex]::Match($r.Body, '"id":"([^"]+)"')).Groups[1].Value }

# D3. 查询刚创建的评估任务详情
if ($evalId) {
  $r = Invoke-Api -Method GET -Path "/api/public/evaluations/$evalId"
  Check "evaluations/{id} 200" ($r.Status -eq 200) "status=$($r.Status)"
}

# ============================================================================
Write-Step "E. 导出 + UI 标注 API"
# ============================================================================

# E1. export CSV（traces / generations）
$r = Invoke-Api -Method GET -Path "/api/export/traces"
Check "export/traces CSV 200" ($r.Status -eq 200) "status=$($r.Status)"
$r = Invoke-Api -Method GET -Path "/api/export/generations"
Check "export/generations CSV 200" ($r.Status -eq 200) "status=$($r.Status)"

# E2. 内部 scores POST（UI 标注链路）
$uiScoreBody = @{ traceId = $traceId; name = "verify-ui-score"; value = 2; dataType = "NUMERIC" } | ConvertTo-Json
$r = Invoke-Api -Method POST -Path "/api/scores" -Body $uiScoreBody
Check "scores POST（UI）201" ($r.Status -eq 201) "status=$($r.Status)"

# ============================================================================
Write-Step "F. 负向用例"
# ============================================================================

$r = Invoke-Api -Method GET -Path "/api/public/traces/not-exist-id"
Check "不存在 trace → 404" ($r.Status -eq 404) "status=$($r.Status)"

$r = Invoke-Api -Method POST -Path "/api/public/otel/v1/traces" -Body '{'
Check "坏 OTLP JSON → 400" ($r.Status -eq 400) "status=$($r.Status)"

# ============================================================================
Write-Step "汇总"
# ============================================================================
Write-Host "  PASS: $($script:Pass)   FAIL: $($script:Fail)" -ForegroundColor $(if ($script:Fail -eq 0) { "Green" } else { "Red" })
if ($script:Fail -gt 0) { exit 1 } else { exit 0 }
