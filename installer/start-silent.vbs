' Live Grid Monitor —— 静默启动器
' 桌面/开始菜单快捷方式调用方式： wscript.exe "start-silent.vbs"
' 行为：后台拉起 node 服务（无控制台窗口）→ 记录 PID → 自动打开浏览器

Option Explicit

Dim fso, wmi, instDir, nodeExe, appEntry, pidFile, port
Set fso = CreateObject("Scripting.FileSystemObject")
instDir = fso.GetParentFolderName(WScript.ScriptFullName)

nodeExe  = instDir & "\runtime\node.exe"
appEntry = instDir & "\app\server\src\index.js"
pidFile  = instDir & "\app\data\server.pid"

If Not fso.FileExists(nodeExe) Then
  MsgBox "未找到 Node 运行时：" & vbCrLf & nodeExe & vbCrLf & vbCrLf & "请重新安装本程序。", vbCritical, "Live Grid Monitor"
  WScript.Quit 1
End If

If Not fso.FileExists(appEntry) Then
  MsgBox "未找到入口文件：" & vbCrLf & appEntry & vbCrLf & vbCrLf & "请重新安装本程序。", vbCritical, "Live Grid Monitor"
  WScript.Quit 1
End If

' 端口以 app\server\.env 中的 PORT 为准，缺省 8787
port = ReadPort(8787)

' 已在运行则直接开浏览器，不重复启动
If fso.FileExists(pidFile) Then
  Dim tsOld, oldPid
  Set tsOld = fso.OpenTextFile(pidFile, 1)
  If Not tsOld.AtEndOfStream Then oldPid = Trim(tsOld.ReadLine())
  tsOld.Close
  If IsNumeric(oldPid) Then
    If ProcessAlive(CLng(oldPid)) Then
      OpenBrowser
      WScript.Quit 0
    End If
  End If
  fso.DeleteFile pidFile, True
End If

' 用 WMI 启动：可拿到 PID，且 ShowWindow=0 完全隐藏控制台
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Dim startup, pid, rc
Set startup = wmi.Get("Win32_ProcessStartup").SpawnInstance_
startup.ShowWindow = 0

rc = wmi.Get("Win32_Process").Create("""" & nodeExe & """ """ & appEntry & """", instDir, startup, pid)
If rc <> 0 Then
  MsgBox "服务启动失败（错误码 " & rc & "）。" & vbCrLf & vbCrLf & _
         "请检查端口 " & port & " 是否被占用，修改 app\server\.env 后重试。", vbCritical, "Live Grid Monitor"
  WScript.Quit 1
End If

If Not fso.FolderExists(fso.GetParentFolderName(pidFile)) Then
  fso.CreateFolder fso.GetParentFolderName(pidFile)
End If
Dim ts
Set ts = fso.CreateTextFile(pidFile, True)
ts.WriteLine pid
ts.Close

WScript.Sleep 2500
OpenBrowser

' ---------------------------------------------------------------- 子过程

Sub OpenBrowser()
  Dim sh
  Set sh = CreateObject("WScript.Shell")
  sh.Run "http://localhost:" & port, 1, False
End Sub

Function ReadPort(defaultPort)
  Dim f, t, line, v
  ReadPort = defaultPort
  f = instDir & "\app\server\.env"
  If Not fso.FileExists(f) Then Exit Function
  Set t = fso.OpenTextFile(f, 1)
  Do Until t.AtEndOfStream
    line = Trim(t.ReadLine())
    If Len(line) > 5 Then
      If UCase(Left(line, 5)) = "PORT=" Then
        v = Trim(Mid(line, 6))
        If IsNumeric(v) Then
          ReadPort = CLng(v)
          t.Close
          Exit Function
        End If
      End If
    End If
  Loop
  t.Close
End Function

Function ProcessAlive(p)
  Dim w, list, it
  ProcessAlive = False
  Set w = GetObject("winmgmts:\\.\root\cimv2")
  Set list = w.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & p)
  For Each it In list
    ProcessAlive = True
  Next
End Function
