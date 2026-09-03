' Live Grid Monitor —— 停止服务
' 结束 node 主进程及其 ffmpeg 转码子进程，并清理 PID 文件

Option Explicit

Dim fso, wmi, instDir, pidFile, pid, ts, raw
Set fso = CreateObject("Scripting.FileSystemObject")
instDir = fso.GetParentFolderName(WScript.ScriptFullName)
pidFile = instDir & "\app\data\server.pid"

If Not fso.FileExists(pidFile) Then
  MsgBox "服务当前未在运行。", vbInformation, "Live Grid Monitor"
  WScript.Quit 0
End If

Set ts = fso.OpenTextFile(pidFile, 1)
raw = ""
If Not ts.AtEndOfStream Then raw = Trim(ts.ReadLine())
ts.Close

If Not IsNumeric(raw) Then
  fso.DeleteFile pidFile, True
  MsgBox "PID 文件无效，已清理。服务未在运行。", vbInformation, "Live Grid Monitor"
  WScript.Quit 0
End If

pid = CLng(raw)
Set wmi = GetObject("winmgmts:\\.\root\cimv2")

' 先结束子进程（ffmpeg 转码进程），避免残留
Dim children, c, killed
killed = 0
Set children = wmi.ExecQuery("SELECT ProcessId,Name FROM Win32_Process WHERE ParentProcessId=" & pid)
On Error Resume Next
For Each c In children
  c.Terminate
  killed = killed + 1
Next
On Error GoTo 0

' 再结束主进程
Dim mains, m, stopped
stopped = False
Set mains = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & pid)
On Error Resume Next
For Each m In mains
  m.Terminate
  stopped = True
Next
On Error GoTo 0

fso.DeleteFile pidFile, True

If stopped Then
  MsgBox "服务已停止。" & vbCrLf & "同时回收 " & killed & " 个转码子进程。", vbInformation, "Live Grid Monitor"
Else
  MsgBox "服务已不在运行，PID 文件已清理。", vbInformation, "Live Grid Monitor"
End If
