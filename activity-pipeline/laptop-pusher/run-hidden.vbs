' run-hidden.vbs — launch a PowerShell script with NO visible window (SW_HIDE), no flash.
' Task Scheduler + `powershell -WindowStyle Hidden` under an interactive logon still flashes a
' console window for the script's runtime. Launching via wscript with window style 0 starts it
' fully hidden. Usage (from a scheduled task):  wscript.exe "run-hidden.vbs" "C:\path\to\script.ps1"
' 0 = hidden window (no flash), True = wait so we can propagate the real exit code
' (fire-and-forget made the task always report success, hiding pusher failures).
Set sh = CreateObject("WScript.Shell")
rc = sh.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & WScript.Arguments(0) & """", 0, True)
WScript.Quit rc
