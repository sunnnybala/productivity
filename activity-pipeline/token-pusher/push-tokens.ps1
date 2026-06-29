<#
================================================================================
 push-tokens.ps1  —  Laptop -> Supabase token-spend pusher (Claude Code + Codex)
================================================================================
 Runs ccusage, filters to Claude Code + Codex, upserts daily per-model token
 usage into Supabase. Idempotent. Reuses the activity pusher's config.json
 (same supabase_url / anon key / device_id).

 DATA FLOW
   AW /api/0/info (or config.device_id) -> device_id  (same id as activity rows)
        |
   npx ccusage daily --json --timezone Asia/Kolkata --offline [--since N]
        |   per modelBreakdown: tag tool (allowlist), drop openclaw/synthetic/unknown
        |   row id = device|usage_date|model   (tool is a column, not in the id)
        v
   Supabase POST /rest/v1/token_usage   (batches; merge-duplicates upsert)

 USAGE
   .\push-tokens.ps1            # trailing 45-day window (for the daily schedule)
   .\push-tokens.ps1 -Full      # full history backfill (run once)
   .\push-tokens.ps1 -DryRun    # parse + print plan, no upload
================================================================================
#>
param(
  [string]$ConfigPath = "$PSScriptRoot\..\laptop-pusher\config.json",
  [switch]$Full,
  [switch]$DryRun,
  [int]$BatchSize = 500,
  [int]$WindowDays = 45
)

$ErrorActionPreference = "Stop"
function Log($m) { Write-Host ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $m) }

# ---- config (reuse the activity pusher's) -----------------------------------
$awBase = "http://localhost:5600/api/0"
$cfg = $null
if (Test-Path $ConfigPath) {
  $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
  if ($cfg.aw_base) { $awBase = $cfg.aw_base }
} elseif (-not $DryRun) {
  throw "No config at $ConfigPath (reuses the laptop-pusher config.json)."
}

# ---- device_id: config override, else AW /info (same id activity rows use) ---
$deviceId = $null
if ($cfg -and $cfg.device_id) { $deviceId = $cfg.device_id }
else {
  try { $deviceId = (Invoke-RestMethod "$awBase/info" -TimeoutSec 5).device_id }
  catch { throw "Could not resolve device_id (config.device_id null and ActivityWatch not reachable at $awBase). Pin device_id in config.json." }
}
Log ("device_id={0}" -f $deviceId)

# ---- tool tagging: allowlist (drop openclaw / synthetic / unknown agents) ----
function Get-Tool($model) {
  if ([string]::IsNullOrWhiteSpace($model)) { return $null }
  $s = $model.ToLower()
  if ($s -match 'openclaw')                          { return $null }          # excluded by decision
  if ($s -match 'gpt|codex')                         { return 'codex' }
  if ($s -match 'claude|opus|sonnet|haiku|fable')    { return 'claude-code' }
  return $null                                                                  # <synthetic>, other agents
}

# ---- run ccusage ------------------------------------------------------------
# NOTE: call npx as a native command, NOT `& npx @array` — array splatting breaks
# npx arg parsing on Windows ("could not determine executable to run").
try {
  if ($Full) {
    Log "running: npx -y ccusage@latest daily --json --timezone Asia/Kolkata --offline"
    $raw = npx -y ccusage@latest daily --json --timezone Asia/Kolkata --offline 2>$null | Out-String
  } else {
    $since = (Get-Date).AddDays(-$WindowDays).ToString('yyyyMMdd')
    Log ("running: npx -y ccusage@latest daily --json --timezone Asia/Kolkata --offline --since {0}" -f $since)
    $raw = npx -y ccusage@latest daily --json --timezone Asia/Kolkata --offline --since $since 2>$null | Out-String
  }
  if ([string]::IsNullOrWhiteSpace($raw)) { throw "ccusage produced no output (is npx/ccusage available?)" }
  $json = $raw | ConvertFrom-Json
} catch {
  Log ("ccusage failed: {0}" -f $_.Exception.Message); exit 1
}

# ---- transform --------------------------------------------------------------
$rows = New-Object System.Collections.ArrayList
$dropped = 0
foreach ($d in @($json.daily)) {
  foreach ($mb in @($d.modelBreakdowns)) {
    $tool = Get-Tool $mb.modelName
    if (-not $tool) { $dropped++; continue }
    function AsLong($v) { if ($null -eq $v) { return [long]0 } else { return [long]$v } }
    $inp = AsLong $mb.inputTokens
    $out = AsLong $mb.outputTokens
    $cc  = AsLong $mb.cacheCreationTokens
    $cr  = AsLong $mb.cacheReadTokens
    [void]$rows.Add([pscustomobject]@{
      id                  = ('{0}|{1}|{2}' -f $deviceId, $d.period, $mb.modelName)
      device_id           = $deviceId
      usage_date          = $d.period
      tool                = $tool
      model               = $mb.modelName
      input_tokens        = $inp
      output_tokens       = $out
      cache_create_tokens = $cc
      cache_read_tokens   = $cr
      total_tokens        = ($inp + $out + $cc + $cr)
      cost_usd            = [double]$mb.cost
    })
  }
}
Log ("rows={0}  dropped(openclaw/synthetic/unknown)={1}" -f $rows.Count, $dropped)
if ($rows.Count -eq 0) { Log "nothing to push."; exit 0 }

# ---- upsert -----------------------------------------------------------------
if ($DryRun) {
  $rows | Group-Object tool | ForEach-Object { Log ("  {0}: {1} rows" -f $_.Name, $_.Count) }
  Log "DRY RUN - nothing uploaded."; exit 0
}
$u = '{0}/rest/v1/token_usage' -f $cfg.supabase_url
$h = @{ apikey = $cfg.supabase_anon_key; Authorization = ("Bearer " + $cfg.supabase_anon_key)
        "Content-Type" = "application/json"; Prefer = "return=minimal,resolution=merge-duplicates" }
$arr = @($rows)
for ($i = 0; $i -lt $arr.Count; $i += $BatchSize) {
  $chunk = $arr[$i..([math]::Min($i+$BatchSize-1, $arr.Count-1))]
  $body  = ConvertTo-Json @($chunk) -Depth 6 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)   # PS 5.1 Latin-1 fix
  try {
    Invoke-RestMethod $u -Method Post -Headers $h -Body $bytes -TimeoutSec 60 | Out-Null
  } catch {
    Log ("upsert FAILED at batch {0}: {1}" -f $i, $_.Exception.Message); exit 1
  }
}
Log ("Done. Pushed {0} token rows." -f $arr.Count)
