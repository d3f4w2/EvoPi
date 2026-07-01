# EvoPi 端到端验证脚本（真 Pi + 真 model）
# ---------------------------------------------------------------------------
# 目的：把「真码离线驱动」的自测，升级为「真实 Pi 运行时 + 真实模型对话」端到端闭环，
#       确认 evopi-trace 扩展被真实加载、各模块事件真实产出到 JSONL。
#
# 前置（三条，缺一不可，都是被源码验证过的硬约束）：
#   1. 依赖：Pi 参考仓 D:\evopi\pi 需已 `npm install`（需要 jiti 扩展加载器 + tsx TS 运行器）。
#   2. 信任：--print/--mode json 是非交互模式，项目信任默认 false → 本地 .pi/extensions 会被跳过。
#            必须加 --approve 强制信任，扩展才会加载（见 impl/进度.md「端到端验证」小节根因）。
#   3. stdin：非 TTY 下 Pi 会阻塞等 stdin 的 EOF，prompt 必须走管道喂入（见脚本末尾）。
#
# 用法（PowerShell）：
#   $env:ZHIPU_API_KEY = "<你的网关 key>"      # 不要把 key 写进任何文件
#   ./run-e2e.ps1
#
# 模型/网关：默认用智谱网关 OpenAI 兼容端点 + glm-4-flash（实测稳定可用）。
#   models.json 模板见同目录 models.json.template，apiKey 用 $ZHIPU_API_KEY 插值，
#   放进隔离 agent dir（PI_CODING_AGENT_DIR），不碰用户全局 ~/.pi。
$ErrorActionPreference = "Stop"

if (-not $env:ZHIPU_API_KEY) {
  Write-Host "!! 未设置 ZHIPU_API_KEY。先执行： `$env:ZHIPU_API_KEY = '<你的 key>'" -ForegroundColor Red
  exit 1
}

$PI     = "D:\evopi\pi"
$PROJ   = "D:\evopi"                                  # 扩展所在 cwd（.pi/extensions/evopi-trace 从这里被发现）
$TSX    = Join-Path $PI "node_modules\.bin\tsx.cmd"
$CLI    = Join-Path $PI "packages\coding-agent\src\cli.ts"
$TSCONF = Join-Path $PI "tsconfig.json"
$TRACES = Join-Path $PROJ ".pi\evopi\traces"

# 隔离 agent dir：放 models.json，避免污染用户全局配置。默认用系统临时目录。
$AGENT = Join-Path $env:TEMP "evopi-e2e-agent"
New-Item -ItemType Directory -Force -Path $AGENT | Out-Null
Copy-Item (Join-Path $PSScriptRoot "models.json.template") (Join-Path $AGENT "models.json") -Force
$env:PI_CODING_AGENT_DIR = $AGENT

Write-Host "=== 配置 ===" -ForegroundColor Cyan
Write-Host "PI / cwd    = $PI  /  $PROJ"
Write-Host "AGENT dir   = $AGENT"
Write-Host "tsx / cli   = $(Test-Path $TSX)  /  $(Test-Path $CLI)"

# 记录跑前已有 trace，识别本轮新产出
$before = @()
if (Test-Path $TRACES) { $before = Get-ChildItem $TRACES -Filter *.jsonl -EA SilentlyContinue | Select-Object -Expand FullName }

# --- 冒烟：--list-models 确认 provider 注册 + 扩展加载无错 ---
Write-Host "`n=== 冒烟：--list-models ===" -ForegroundColor Cyan
Push-Location $PROJ
try { $lm = & $TSX --tsconfig $TSCONF $CLI --list-models 2>&1 | Out-String } finally { Pop-Location }
Write-Host (($lm -split "`r?`n" | Where-Object { $_ -match "zhipu|glm|[Ee]rror" } | Select-Object -First 10) -join "`n")

# --- 真跑一轮：--approve 信任 + stdin 管道喂 prompt ---
Write-Host "`n=== 真跑一轮：pi --print --mode json --approve ===" -ForegroundColor Cyan
Push-Location $PROJ
try {
  $out = "Reply with exactly one word: OK" |
    & $TSX --tsconfig $TSCONF $CLI --print --mode json --approve --provider zhipu --model "glm-4-flash" 2>&1 | Out-String
} finally { Pop-Location }
$stop = ($out -match '"stopReason":"stop"')
Write-Host "模型是否正常返回（stopReason=stop）: $stop"

# --- 核查扩展事件 ---
Write-Host "`n=== 扩展事件核查 ===" -ForegroundColor Cyan
$after = @()
if (Test-Path $TRACES) { $after = Get-ChildItem $TRACES -Filter *.jsonl -EA SilentlyContinue | Select-Object -Expand FullName }
$new = $after | Where-Object { $before -notcontains $_ }
if (-not $new) { $new = Get-ChildItem $TRACES -Filter *.jsonl -EA SilentlyContinue | Sort-Object LastWriteTime -Desc | Select-Object -First 1 -Expand FullName }
if (-not $new) { Write-Host "!! 没有产出任何 trace JSONL —— 扩展未加载（检查 --approve / cwd）" -ForegroundColor Red; exit 2 }
Write-Host "本轮 trace: $new"

$types = @{}
Get-Content $new -EA SilentlyContinue | ForEach-Object {
  if ($_.Trim()) { try { $e = $_ | ConvertFrom-Json; if ($e.type) { $types[$e.type] = ($types[$e.type] + 1) } } catch {} }
}
Write-Host "`n--- 事件类型统计 ---"
$types.GetEnumerator() | Sort-Object Name | ForEach-Object { Write-Host ("  {0,-20} x{1}" -f $_.Key, $_.Value) }

# --- 断言 ---
Write-Host "`n=== 断言 ===" -ForegroundColor Cyan
$pass = 0; $fail = 0
function Check($n, $c) { if ($c) { $script:pass++; Write-Host "  [PASS] $n" -ForegroundColor Green } else { $script:fail++; Write-Host "  [FAIL] $n" -ForegroundColor Red } }
Check "session.start（含 trusted:true）" ($types.ContainsKey("session.start"))
Check "turn.start"                        ($types.ContainsKey("turn.start"))
Check "message.end"                       ($types.ContainsKey("message.end"))
Check "cost.request（真实 provider usage）" ($types.ContainsKey("cost.request"))
Check "agent.end / session.shutdown 生命周期完整" ($types.ContainsKey("agent.end") -and $types.ContainsKey("session.shutdown"))

Write-Host "`n$pass passed, $fail failed" -ForegroundColor $(if ($fail -gt 0) { "Red" } else { "Green" })
if ($fail -gt 0) { exit 1 }
