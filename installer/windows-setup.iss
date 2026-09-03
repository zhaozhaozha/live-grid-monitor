; Live Grid Monitor —— Windows 安装包脚本（Inno Setup 6）
; 编译: ISCC.exe windows-setup.iss
; 产物: installer\output\LiveGridMonitor-<version>-Setup.exe

; 版本号可由 ISCC 的 /DMyAppVersion=x.y.z 覆盖，CI 会从 git tag 自动带入
#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif

#define MyAppName      "Live Grid Monitor"
#define MyAppPublisher "live-grid-monitor"
#define MyAppURL       "https://github.com/zhaozhaozha/live-grid-monitor"
#define MyLauncher     "start-silent.vbs"

[Setup]
AppId={{A7F3E2D1-5C4B-4A9E-8D6F-1B2C3D4E5F60}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={autopf}\LiveGridMonitor
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=auto
DisableDirPage=auto
OutputDir=output
OutputBaseFilename=LiveGridMonitor-{#MyAppVersion}-Setup
SetupIconFile=assets\app.ico
UninstallDisplayIcon={app}\assets\app.ico
UninstallDisplayName={#MyAppName} {#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
WizardResizable=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequiredOverridesAllowed=dialog
LicenseFile=..\LICENSE
ChangesEnvironment=yes

[Languages]
; 自带精简中文语言包：runner 上的 Inno Setup 常是精简版，不带 Languages 目录
Name: "chinesesimplified"; MessagesFile: "languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
chinesesimplified.LaunchDesc=安装后立即启动 {#MyAppName}
english.LaunchDesc=Launch {#MyAppName} after installation
chinesesimplified.OpenFolder=打开安装目录
english.OpenFolder=Open install folder

[Files]
Source: "payload\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
; 桌面快捷方式：指向静默启动器，无控制台黑窗
Name: "{autodesktop}\{#MyAppName}"; \
  Filename: "wscript.exe"; \
  Parameters: """{app}\{#MyLauncher}"""; \
  IconFilename: "{app}\assets\app.ico"; \
  Comment: "启动 {#MyAppName}"

; 开始菜单
Name: "{group}\{#MyAppName}"; \
  Filename: "wscript.exe"; \
  Parameters: """{app}\{#MyLauncher}"""; \
  IconFilename: "{app}\assets\app.ico"; \
  Comment: "启动 {#MyAppName}"

Name: "{group}\停止服务"; \
  Filename: "wscript.exe"; \
  Parameters: """{app}\stop.vbs"""; \
  IconFilename: "{app}\assets\app.ico"; \
  Comment: "停止后台服务并回收转码进程"

Name: "{group}\编辑配置"; \
  Filename: "{app}\app\server\.env"; \
  IconFilename: "{app}\assets\app.ico"; \
  Comment: "修改端口或平台 Cookie"

Name: "{group}\数据目录"; \
  Filename: "{app}\app\data"; \
  IconFilename: "{app}\assets\app.ico"; \
  Comment: "SQLite 数据库位置"

Name: "{group}\卸载 {#MyAppName}"; \
  Filename: "{uninstallexe}"

[Run]
Filename: "wscript.exe"; \
  Parameters: """{app}\{#MyLauncher}"""; \
  Description: "{cm:LaunchDesc}"; \
  Flags: postinstall nowait skipifsilent

[UninstallDelete]
; 卸载时清掉运行时产生的数据库与 PID，程序文件由卸载器自行删除
Type: files; Name: "{app}\app\data\server.pid"

[Code]
function InitializeSetup(): Boolean;
begin
  if not IsWin64 then begin
    MsgBox('本程序需要 64 位 Windows 系统。', mbError, MB_OK);
    Result := False;
    Exit;
  end;
  Result := True;
end;
