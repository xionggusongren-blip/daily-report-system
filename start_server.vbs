Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Tools\daily-report-system"
WshShell.Run "node app.js", 0, False