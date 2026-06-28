<#
================================================================================
 push-activity.ps1  —  Laptop -> Supabase activity pusher (Phase 1, Lane A)
================================================================================
 Reads ActivityWatch events since the last successful sync and upserts them into
 Supabase. Incremental + idempotent. No data loss across sleeps/offline/crashes.

 DATA FLOW
 ---------
   AW /api/0/info  -> device_id (stable)
        |
   for each bucket (window | afk | web-chrome | web-brave):
        |   cursor = Supabase.sync_state.last_event_ts   (default: epoch)
        v
   AW /buckets/<b>/events?start=cursor-5min&end=now
        |   transform -> rows (deterministic id = device|bucket|eventId|ts)
        v
   Supabase POST /rest/v1/laptop_events   (batches; merge-duplicates upsert)
        |   on full success -> write cursor = max(ts pushed)
        v   on any failure  -> leave cursor (next run retries, AW keeps history)

 USAGE
   .\push-activity.ps1 -DryRun                 # read AW, print plan, no upload
   .\push-activity.ps1 -ConfigPath .\config.json
================================================================================
#>
param(
  [string]$ConfigPath = "$PSScriptRoot\config.json",
  [switch]$DryRun,
  [int]$BatchSize = 500
)

$ErrorActionPreference = "Stop"

# ---- config -----------------------------------------------------------------
$awBase = "http://localhost:5600/api/0"
$cfg = $null
if (Test-Path $ConfigPath) {
  $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
  if ($cfg.aw_base) { $awBase = $cfg.aw_base }
} elseif (-not $DryRun) {
  throw "No config at $ConfigPath. Copy config.example.json -> config.json and fill in Supabase URL + anon key. (Or run with -DryRun.)"
}

function Log($m) { Write-Host ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $m) }

# ---- identify this device ---------------------------------------------------
try { $info = Invoke-RestMethod "$awBase/info" -TimeoutSec 5 }
catch { Log "ActivityWatch not reachable at $awBase - is it running? Exiting (will retry next run)."; exit 0 }
$deviceId = if ($cfg -and $cfg.device_id) { $cfg.device_id } else { $info.device_id }
Log ("device_id={0}  host={1}  aw={2}" -f $deviceId, $info.hostname, $info.version)

# ---- map bucket name -> source label ----------------------------------------
function Get-Source($bucket) {
  switch -Regex ($bucket) {
    "aw-watcher-window"     { return "window" }
    "aw-watcher-afk"        { return "afk" }
    "aw-watcher-web-chrome" { return "web-chrome" }
    "aw-watcher-web-brave"  { return "web-brave" }
    "aw-watcher-web-(.+?)_" { return ("web-" + $Matches[1]) }
    default                 { return $bucket }
  }
}

# ---- Supabase helpers (skipped in dry-run) ----------------------------------
function Supa-Headers {
  @{ apikey = $cfg.supabase_anon_key
     Authorization = ("Bearer " + $cfg.supabase_anon_key)
     "Content-Type" = "application/json" }
}
function Get-Cursor($bucket) {
  if ($DryRun) { return $null }
  $u = '{0}/rest/v1/sync_state?device_id=eq.{1}&bucket=eq.{2}&select=last_event_ts' -f `
        $cfg.supabase_url, [uri]::EscapeDataString($deviceId), [uri]::EscapeDataString($bucket)
  $r = Invoke-RestMethod $u -Headers (Supa-Headers) -TimeoutSec 15
  if ($r -and $r.Count -gt 0 -and $r[0].last_event_ts) { return $r[0].last_event_ts }
  return $null
}
function Upsert-Rows($table, $rows) {
  if ($DryRun) { return $true }
  $u = '{0}/rest/v1/{1}' -f $cfg.supabase_url, $table
  $h = Supa-Headers; $h["Prefer"] = "return=minimal,resolution=merge-duplicates"
  for ($i = 0; $i -lt $rows.Count; $i += $BatchSize) {
    $chunk = $rows[$i..([math]::Min($i+$BatchSize-1, $rows.Count-1))]
    $body = ConvertTo-Json @($chunk) -Depth 8 -Compress
    # PS 5.1 sends string bodies as Latin-1, corrupting non-ASCII titles (®, emoji,
    # em-dash) into invalid UTF-8 -> Postgres 400. Send explicit UTF-8 bytes.
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    Invoke-RestMethod $u -Method Post -Headers $h -Body $bytes -TimeoutSec 60 | Out-Null
  }
  return $true
}
function Set-Cursor($bucket, $ts) {
  if ($DryRun) { return }
  $row = @{ device_id=$deviceId; bucket=$bucket; last_event_ts=$ts; last_synced_at=(Get-Date).ToUniversalTime().ToString("o") }
  $u = '{0}/rest/v1/sync_state' -f $cfg.supabase_url
  $h = Supa-Headers; $h["Prefer"] = "return=minimal,resolution=merge-duplicates"
  $bytes = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json @($row) -Compress))
  Invoke-RestMethod $u -Method Post -Headers $h -Body $bytes -TimeoutSec 30 | Out-Null
}

# ---- main loop --------------------------------------------------------------
$buckets = (Invoke-RestMethod "$awBase/buckets/" -TimeoutSec 10).PSObject.Properties.Name |
           Where-Object { $_ -match "aw-watcher-(window|afk|web-)" }
$nowIso = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss") + "+00:00"
$grand = 0

foreach ($b in $buckets) {
  $source = Get-Source $b
  $cursor = Get-Cursor $b
  if ($cursor) {
    $start = ([datetime]::Parse($cursor)).ToUniversalTime().AddMinutes(-5).ToString("yyyy-MM-ddTHH:mm:ss") + "+00:00"
  } else {
    $start = "1970-01-01T00:00:00+00:00"
  }

  $u = '{0}/buckets/{1}/events?start={2}&end={3}' -f `
        $awBase, $b, [uri]::EscapeDataString($start), [uri]::EscapeDataString($nowIso)
  $events = Invoke-RestMethod $u -TimeoutSec 60
  if (-not $events) { Log ("{0} : 0 new" -f $source); continue }

  $rows = foreach ($e in $events) {
    [pscustomobject]@{
      # id = device|bucket|ts  (NOT event_id: AW reassigns event ids on every read for
      # growing afk/idle events, which created duplicate rows. ts is the stable natural key.)
      id           = ('{0}|{1}|{2}' -f $deviceId, $b, $e.timestamp)
      device_id    = $deviceId
      source       = $source
      bucket       = $b
      ts           = $e.timestamp
      duration_sec = [double]$e.duration
      app          = $e.data.app
      title        = $e.data.title
      url          = $e.data.url
      category     = $null
      data         = $e.data
    }
  }
  $rows = @($rows | Sort-Object ts)
  $maxTs = $rows[-1].ts

  try {
    Upsert-Rows "laptop_events" $rows | Out-Null
    Set-Cursor $b $maxTs
    Log ("{0} : {1,5} events pushed  (through {2})" -f $source, $rows.Count, $maxTs)
    $grand += $rows.Count
  } catch {
    Log ("{0} : FAILED to push ({1}) - cursor not advanced, will retry next run" -f $source, $_.Exception.Message)
  }
}

if ($DryRun) { Log ("DRY RUN - nothing uploaded. Would have pushed {0} events." -f $grand) }
else         { Log ("Done. Pushed {0} events." -f $grand) }
