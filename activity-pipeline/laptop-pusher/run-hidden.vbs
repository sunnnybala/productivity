' run-hidden.vbs — launch a PowerShell script with NO visible window (SW_HIDE), no flash.
' Task Scheduler + `powershell -WindowStyle Hidden` under an interactive logon still flashes a
' console window for the script's runtime. Launching via wscript with window style 0 starts it
' fully hidden. Usage (from a scheduled task):  wscript.exe "run-hidden.vbs" "C:\path\to\script.ps1"
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & WScript.Arguments(0) & """", 0, False
