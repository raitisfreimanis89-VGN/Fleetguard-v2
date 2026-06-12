' FleetGuard gvoice bot watchdog.
' Runs every 5 min via Task Scheduler ("FleetGuard GVoice SMS watchdog").
' Starts the bot ONLY if no instance is running - safe to fire repeatedly.
' wscript host + window style 0 = completely invisible, no console flash.
Const BOT_DIR = "C:\Temp\fleetguard-review\gvoice-sms-service"

Set wmi = GetObject("winmgmts:\\.\root\cimv2")
' Match on the absolute script path so other node processes never count.
Set procs = wmi.ExecQuery( _
  "SELECT ProcessId FROM Win32_Process " & _
  "WHERE Name='node.exe' AND CommandLine LIKE '%gvoice-sms-service%index.js%'")

If procs.Count = 0 Then
  Set sh = CreateObject("WScript.Shell")
  sh.CurrentDirectory = BOT_DIR   ' .env and logs\ resolve relative to here
  sh.Run "cmd /c node """ & BOT_DIR & "\src\index.js"" >> logs\bot.log 2>&1", 0, False
End If

' ngrok tunnel (static domain -> :3000). Same pattern: start only if absent.
' Uses the App Execution Alias path, stable across ngrok store updates.
Set ngrokProcs = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='ngrok.exe'")
If ngrokProcs.Count = 0 Then
  Set sh2 = CreateObject("WScript.Shell")
  ngrokExe = sh2.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Microsoft\WindowsApps\ngrok.exe"
  sh2.Run """" & ngrokExe & """ http --url=unsuited-obituary-pranker.ngrok-free.dev 3000", 0, False
End If
