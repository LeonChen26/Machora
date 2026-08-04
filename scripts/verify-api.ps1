# ============================================================================
# Machora API 全量验证脚本
# 用法（本地）：
#   powershell -ExecutionPolicy Bypass -File scripts\verify-api.ps1
# 用法（云端）：
#   powershell -ExecutionPolicy Bypass -File scripts\verify-api.ps1 -BaseUrl http://115.190.236.156
#
# 凭据默认从包根 .env 读取（MACHORA_INIT_PROJECT_PUBLIC_KEY /
# MACHORA_INIT_PROJECT_SECRET_KEY / MACHORA_INIT_USER_PASSWORD），
# 也可用 -PublicKey / -SecretKey / -Password 显式覆盖。
# 云端部署时 .env 由 deploy.sh 从本地复制，凭据一致，可直接跑。
#
# 覆盖端点（全部）：
#   [公开 · Basic Auth]   GET  /api/public/health
#                         GET  /api/public/traces?limit
#                         GET  /api/public/traces/{id}
#                         GET  /api/public/observations?limit
#                         GET  /api/public/observations/{id}
#                         GET  /api/public/scores?limit
#                         GET  /api/public/evaluations?limit
#                         GET  /api/public/evaluations/{id}
#                         POST /api/public/ingestion
#                         POST /api/public/otel/v1/traces   (OTLP JSON)
#                         POST /api/public/otel/v1/metrics  (OTLP JSON)
#                         POST /api/public/scores           (annotation)
#                         POST /api/public/evaluations      (异步评估任务)
#   [会话 · Cookie]       POST /api/auth/login
#                         POST /api/auth/logout
#                         GET  /api/export/traces        (CSV)
#                         GET  /api/export/generations   (CSV)
#                         POST /api/keys
#                         DELETE /api/keys?id=
#                         POST /api/projects
#                         DELETE /api/projects?id=
#                         POST /api/scores               (UI 标注)
#   [tRPC]                POST /api/trpc/projects.list
#                         POST /api/trpc/traces.list
#                         POST /api/trpc/traces.byId
#   [负向]                无认证 401 / 错误 key 401 / 不存在 404 / 坏 payload 400
# ============================================================================

param(
  [string]$BaseUrl = "http://localhost:3100",
  [string]$PublicKey = "",
  [string]$SecretKey = "",
  [string]$Email = "admin@machora.local",
  [string]$Password = ""
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
    [string]$AuthHeader = "",
    [string]$ContentType = "application/json",
    [Microsoft.PowerShell.Commands.WebRequestSession]$Session = $null
  )
  $headers = @{}
  if ($AuthHeader) { $headers["Authorization"] = $AuthHeader }
  $psArgs = @{ Uri = "$BaseUrl$Path"; Method = $Method; Headers = $headers; ContentType = $ContentType; TimeoutSec = 30 }
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

# ---- 凭据解析 ----
$envFile = Join-Path (Get-Location) ".env"
if ($PublicKey -eq "" -or $SecretKey -eq "" -or $Password -eq "") {
  if (Test-Path $envFile) {
    $envContent = Get-Content $envFile -Raw
    if ($PublicKey -eq "") {
      $m = [regex]::Match($envContent, "MACHORA_INIT_PROJECT_PUBLIC_KEY=(.+)")
      if ($m.Success) { $PublicKey = $m.Groups[1].Value.Trim() }
    }
    if ($SecretKey -eq "") {
      $m = [regex]::Match($envContent, "MACHORA_INIT_PROJECT_SECRET_KEY=(.+)")
      if ($m.Success) { $SecretKey = $m.Groups[1].Value.Trim() }
    }
    if ($Password -eq "") {
      $m = [regex]::Match($envContent, "MACHORA_INIT_USER_PASSWORD=(.+)")
      if ($m.Success) { $Password = $m.Groups[1].Value.Trim() }
    }
  }
}
if ($PublicKey -eq "" -or $SecretKey -eq "") {
  Write-Host "!! 缺少 API Key（.env 未找到或未用参数提供）" -ForegroundColor Yellow
}
$basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$PublicKey`:$SecretKey"))

Write-Host "======================================================"
Write-Host "  Machora API 验证  BaseUrl=$BaseUrl"
Write-Host "======================================================"

$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$traceId = "t-verify-$stamp"
$obsId = "o-verify-$stamp"
$now = [DateTime]::UtcNow.ToString("o")
$nowNano = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString() + "000000"

# ============================================================================
Write-Step "A. 公开只读 API（Basic Auth）"
# ============================================================================

$r = Invoke-Api -Method GET -Path "/api/public/health"
Check "health 200" ($r.Status -eq 200) "status=$($r.Status)"

$r = Invoke-Api -Method GET -Path "/api/public/traces?limit=5" -AuthHeader "Basic $basic"
Check "traces list 200" ($r.Status -eq 200) "status=$($r.Status)"

$r = Invoke-Api -Method GET -Path "/api/public/observations?limit=5" -AuthHeader "Basic $basic"
Check "observations list 200" ($r.Status -eq 200) "status=$($r.Status)"

$r = Invoke-Api -Method GET -Path "/api/public/scores?limit=5" -AuthHeader "Basic $basic"
Check "scores list 200" ($r.Status -eq 200) "status=$($r.Status)"

$r = Invoke-Api -Method GET -Path "/api/public/evaluations?limit=5" -AuthHeader "Basic $basic"
Check "evaluations list 200" ($r.Status -eq 200) "status=$($r.Status)"

# ============================================================================
Write-Step "B. 注入 API（ingestion + OTLP traces + OTLP metrics）"
# ============================================================================

# B1. /api/public/ingestion —— trace + observation + score 批量
$ingBody = @{
  batch = @(
    @{ type = "trace-create"; body = @{ id = $traceId; name = "verify-ingestion"; timestamp = $now; environment = "verify"; input = "hello"; output = "world"; tags = @("verify") } },
    @{ type = "observation-create"; body = @{ id = $obsId; traceId = $traceId; type = "GENERATION"; name = "llm-call"; startTime = $now; endTime = $now; model = "gpt-4o-mini"; input = "hi"; output = "bye"; level = "DEFAULT"; usage = @{ promptTokens = 10; completionTokens = 5 } } },
    @{ type = "score-create"; body = @{ traceId = $traceId; name = "verify-score"; value = 0.9; dataType = "NUMERIC" } }
  )
} | ConvertTo-Json -Depth 10
$r = Invoke-Api -Method POST -Path "/api/public/ingestion" -Body $ingBody -AuthHeader "Basic $basic"
$ok = $r.Status -eq 200 -and $r.Body -match '"success":true' -and $r.Body -match '"received":3'
Check "ingestion 批量写入 200" $ok "status=$($r.Status) body=$($r.Body)"

# B2. /api/public/otel/v1/traces —— OTLP JSON 通道
$otelTraceBody = @{
  resourceSpans = @(
    @{
      resource = @{ attributes = @(@{ key = "service.name"; value = @{ stringValue = "verify-otel" } }) }
      scopeSpans = @(
        @{
          scope = @{}
          spans = @(
            @{
              traceId = "0000000000000000000000000000000$stamp"
              spanId = "0000000000000001"
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
$r = Invoke-Api -Method POST -Path "/api/public/otel/v1/traces" -Body $otelTraceBody -AuthHeader "Basic $basic"
$ok = $r.Status -eq 200 -and $r.Body -match '"success":true' -and $r.Body -match '"traces":1'
Check "OTLP traces 注入 200" $ok "status=$($r.Status) body=$($r.Body)"

# B3. /api/public/otel/v1/metrics —— OTLP JSON gauge
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
$r = Invoke-Api -Method POST -Path "/api/public/otel/v1/metrics" -Body $otelMetricBody -AuthHeader "Basic $basic"
$ok = $r.Status -eq 200 -and $r.Body -match '"success":true' -and $r.Body -match '"metrics":1'
Check "OTLP metrics 注入 200" $ok "status=$($r.Status) body=$($r.Body)"

# ============================================================================
Write-Step "C. 详情查询（读回刚写入的数据）"
# ============================================================================

$r = Invoke-Api -Method GET -Path "/api/public/traces/$traceId" -AuthHeader "Basic $basic"
Check "traces/{id} 200 且 name 匹配" ($r.Status -eq 200 -and $r.Body -match "verify-ingestion") "status=$($r.Status)"

$r = Invoke-Api -Method GET -Path "/api/public/observations/$obsId" -AuthHeader "Basic $basic"
Check "observations/{id} 200" ($r.Status -eq 200) "status=$($r.Status)"

$r = Invoke-Api -Method GET -Path "/api/public/scores?traceId=$traceId" -AuthHeader "Basic $basic"
Check "scores?traceId 过滤" ($r.Status -eq 200 -and $r.Body -match '"totalCount":[1-9]') "status=$($r.Status) body=$($r.Body)"

$r = Invoke-Api -Method GET -Path "/api/public/traces?name=verify-otel-span" -AuthHeader "Basic $basic"
Check "traces?name 过滤（OTLP 链路）" ($r.Status -eq 200 -and $r.Body -match "verify-otel") "status=$($r.Status)"

# ============================================================================
Write-Step "D. 标注 + 评估（public scores POST / evaluations POST）"
# ============================================================================

# D1. POST /api/public/scores —— annotation 提交
$scoreBody = @{ traceId = $traceId; name = "verify-annotation"; value = 1; dataType = "BOOLEAN"; comment = "verify" } | ConvertTo-Json
$r = Invoke-Api -Method POST -Path "/api/public/scores" -Body $scoreBody -AuthHeader "Basic $basic"
Check "public scores POST 201" ($r.Status -eq 201) "status=$($r.Status) body=$($r.Body)"

# D2. POST /api/public/evaluations —— 异步评估任务（内置 error 评估器）
$evalBody = @{ traceId = $traceId; name = "verify-eval"; evaluatorType = "error" } | ConvertTo-Json
$r = Invoke-Api -Method POST -Path "/api/public/evaluations" -Body $evalBody -AuthHeader "Basic $basic"
Check "evaluations POST 201" ($r.Status -eq 201) "status=$($r.Status) body=$($r.Body)"
$evalId = ""
if ($r.Status -eq 201) { $evalId = ([regex]::Match($r.Body, '"id":"([^"]+)"')).Groups[1].Value }

# D3. 查询刚创建的评估任务详情
if ($evalId) {
  $r = Invoke-Api -Method GET -Path "/api/public/evaluations/$evalId" -AuthHeader "Basic $basic"
  Check "evaluations/{id} 200" ($r.Status -eq 200) "status=$($r.Status)"
}

# ============================================================================
Write-Step "E. 会话鉴权 API（login cookie 链路）"
# ============================================================================

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$loginBody = @{ email = $Email; password = $Password } | ConvertTo-Json
$r = Invoke-Api -Method POST -Path "/api/auth/login" -Body $loginBody -Session $session
Check "auth/login 200（set-cookie）" ($r.Status -eq 200) "status=$($r.Status) body=$($r.Body)"

# E1. export CSV（traces / generations）
$r = Invoke-Api -Method GET -Path "/api/export/traces" -Session $session
Check "export/traces CSV 200" ($r.Status -eq 200) "status=$($r.Status)"
$r = Invoke-Api -Method GET -Path "/api/export/generations" -Session $session
Check "export/generations CSV 200" ($r.Status -eq 200) "status=$($r.Status)"

# E2. 管理 API：项目 create → key create → 用新 key 调 public API → 删除 key → 删除项目
$projBody = @{ name = "verify-proj-$stamp" } | ConvertTo-Json
$r = Invoke-Api -Method POST -Path "/api/projects" -Body $projBody -Session $session
Check "projects POST 200" ($r.Status -eq 200 -and $r.Body -match "verify-proj") "status=$($r.Status) body=$($r.Body)"
$projId = ""
if ($r.Status -eq 200) { $projId = ([regex]::Match($r.Body, '"id":"([^"]+)"')).Groups[1].Value }

$keyBody = @{ name = "verify-key-$stamp"; projectId = $projId } | ConvertTo-Json
$r = Invoke-Api -Method POST -Path "/api/keys" -Body $keyBody -Session $session
Check "keys POST 200" ($r.Status -eq 200 -and $r.Body -match "pk-") "status=$($r.Status) body=$($r.Body)"
$newPub = ""; $newSec = ""; $keyId = ""
if ($r.Status -eq 200) {
  $newPub = ([regex]::Match($r.Body, '"publicKey":"([^"]+)"')).Groups[1].Value
  $newSec = ([regex]::Match($r.Body, '"secretKey":"([^"]+)"')).Groups[1].Value
  $keyId = ([regex]::Match($r.Body, '"id":"([^"]+)"')).Groups[1].Value
}

# E3. 用新建 API Key 调 public API（验证 key 真实可用）
if ($newPub -and $newSec) {
  $newBasic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$newPub`:$newSec"))
  $r = Invoke-Api -Method GET -Path "/api/public/traces?limit=1" -AuthHeader "Basic $newBasic"
  Check "新 API Key 可调 public API" ($r.Status -eq 200) "status=$($r.Status)"
}

# E4. 删除 API Key
if ($keyId) {
  $r = Invoke-Api -Method DELETE -Path "/api/keys?id=$keyId" -Session $session
  Check "keys DELETE 200" ($r.Status -eq 200) "status=$($r.Status)"
}

# E5. 删除项目
if ($projId) {
  $r = Invoke-Api -Method DELETE -Path "/api/projects?id=$projId" -Session $session
  Check "projects DELETE 200" ($r.Status -eq 200) "status=$($r.Status) body=$($r.Body)"
}

# E6. 内部 scores POST（UI 标注链路）
$uiScoreBody = @{ traceId = $traceId; name = "verify-ui-score"; value = 2; dataType = "NUMERIC" } | ConvertTo-Json
$r = Invoke-Api -Method POST -Path "/api/scores" -Body $uiScoreBody -Session $session
Check "scores POST（session）201" ($r.Status -eq 201) "status=$($r.Status)"

# E7. logout（303 重定向到 /login，用 curl 不跟随重定向取原始状态码）
$logoutStatus = (& curl.exe -s -o NUL -w "%{http_code}" -X POST "$BaseUrl/api/auth/logout") 2>$null
Check "auth/logout 303" ($logoutStatus -eq "303") "got=$logoutStatus"

# ============================================================================
Write-Step "F. tRPC"
# ============================================================================

$r = Invoke-Api -Method POST -Path "/api/trpc/projects.list?batch=1" -Body '{"json":null}'
Check "trpc projects.list 200" ($r.Status -eq 200) "status=$($r.Status)"

$from = [DateTime]::UtcNow.AddDays(-1).ToString("o")
$to = [DateTime]::UtcNow.AddDays(1).ToString("o")
$trpcBody = @{ json = @{ from = $from; to = $to } } | ConvertTo-Json -Depth 5
$r = Invoke-Api -Method POST -Path "/api/trpc/traces.list?batch=1" -Body $trpcBody
Check "trpc traces.list 200" ($r.Status -eq 200) "status=$($r.Status)"

$trpcBody2 = @{ json = @{ id = $traceId } } | ConvertTo-Json -Depth 5
$r = Invoke-Api -Method POST -Path "/api/trpc/traces.byId?batch=1" -Body $trpcBody2
Check "trpc traces.byId 200" ($r.Status -eq 200) "status=$($r.Status)"

# ============================================================================
Write-Step "G. 负向用例"
# ============================================================================

$r = Invoke-Api -Method GET -Path "/api/public/traces?limit=1"
Check "无认证 → 401" ($r.Status -eq 401) "status=$($r.Status)"

$r = Invoke-Api -Method GET -Path "/api/public/traces?limit=1" -AuthHeader "Basic d3Jvbmc6d3Jvbmc="
Check "错误 API Key → 401" ($r.Status -eq 401) "status=$($r.Status)"

$r = Invoke-Api -Method GET -Path "/api/public/traces/not-exist-id" -AuthHeader "Basic $basic"
Check "不存在 trace → 404" ($r.Status -eq 404) "status=$($r.Status)"

$r = Invoke-Api -Method POST -Path "/api/public/ingestion" -Body '{"foo":"bar"}' -AuthHeader "Basic $basic"
Check "坏 ingestion payload → 400" ($r.Status -eq 400) "status=$($r.Status)"

$r = Invoke-Api -Method POST -Path "/api/public/otel/v1/traces" -Body '{' -AuthHeader "Basic $basic"
Check "坏 OTLP JSON → 400" ($r.Status -eq 400) "status=$($r.Status)"

# ============================================================================
Write-Step "汇总"
# ============================================================================
Write-Host "  PASS: $($script:Pass)   FAIL: $($script:Fail)" -ForegroundColor $(if ($script:Fail -eq 0) { "Green" } else { "Red" })
if ($script:Fail -gt 0) { exit 1 } else { exit 0 }
