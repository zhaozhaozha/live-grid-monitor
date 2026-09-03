; Live Grid Monitor —— Inno Setup 简体中文语言文件（精简版）
; 未在此定义的消息会自动回落到 Inno Setup 内置的英文默认值。
; 编码：UTF-8 with BOM，换行：CRLF

[LangOptions]
LanguageName=简体中文
LanguageID=$0804
LanguageCodePage=936

[Messages]

; ---- 通用按钮 ----
ButtonBack=< 上一步(&B)
ButtonNext=下一步(&N) >
ButtonInstall=安装(&I)
ButtonCancel=取消
ButtonFinish=完成(&F)
ButtonBrowse=浏览(&R)...
ButtonYes=是(&Y)
ButtonNo=否(&N)
ButtonOK=确定
ButtonClose=关闭

; ---- 向导标题 ----
SetupAppTitle=安装
SetupWindowTitle=安装 - %1
UninstallAppTitle=卸载
UninstallAppFullTitle=%1 卸载

; ---- 欢迎页 ----
WizardWelcome=欢迎
WelcomeLabel1=欢迎使用 [name] 安装向导
WelcomeLabel2=现在将把 [name/ver] 安装到您的电脑中。%n%n建议您在继续之前关闭所有其他应用程序。

; ---- 许可协议页 ----
WizardLicense=许可协议
LicenseLabel=请在继续之前阅读以下重要信息。
LicenseLabel3=请阅读下列许可协议。在继续安装前，您必须接受本协议条款。
LicenseAccepted=我接受协议(&A)
LicenseNotAccepted=我不接受协议(&D)

; ---- 选择目标位置 ----
WizardSelectDir=选择目标位置
SelectDirDesc=您想将 [name] 安装在哪里？
SelectDirLabel3=安装程序将把 [name] 安装到下列文件夹中。%n%n要继续，请单击“下一步”。如果您想选择其他文件夹，请单击“浏览”。
SelectDirBrowseLabel=为避免某些程序出现问题，请选择一个不包含单引号的路径。
DiskSpaceGBLabel=所需空间：%.2f GB
DiskSpaceMBLabel=所需空间：%.2f MB
SpaceAvailableLabel=可用空间：%.2f MB

; ---- 开始菜单文件夹 ----
WizardSelectProgramGroup=选择开始菜单文件夹
SelectStartMenuFolderDesc=安装程序将在下列开始菜单文件夹中创建程序的快捷方式。
SelectStartMenuFolderLabel3=要继续，请单击“下一步”。如果您想选择其他文件夹，请单击“浏览”。
SelectStartMenuFolderBrowseLabel=要继续，请单击“下一步”。如果您想选择其他文件夹，请单击“浏览”。

; ---- 附加任务 ----
WizardSelectTasks=选择附加任务
SelectTasksDesc=您想让安装程序执行哪些附加任务？
SelectTasksLabel2=请选择安装 [name] 期间安装程序应执行的附加任务，然后单击“下一步”。

; ---- 准备安装 ----
WizardReady=准备安装
ReadyLabel1=安装程序现在准备开始将 [name] 安装到您的电脑中。
ReadyLabel2a=请单击“安装”继续此安装程序；如果您想复查或更改任何设置，请单击“上一步”。
ReadyMemoDir=目标位置：
ReadyMemoGroup=开始菜单文件夹：
ReadyMemoTasks=附加任务：

; ---- 安装过程 ----
WizardPreparing=正在准备安装
PreparingDesc=安装程序正在准备将 [name] 安装到您的电脑中。
WizardInstalling=正在安装
InstallingLabel=安装程序正在安装 [name] 到您的电脑中，请稍候。
ProgressGaugeLabel=正在安装文件...
StatusExtractFiles=正在解压缩文件...
StatusCreateIcons=正在创建快捷方式...
StatusCreateUninstallEntry=正在创建卸载条目...
StatusRollback=正在撤销更改...

; ---- 完成 ----
WizardFinished=安装完成
FinishedHeadingLabel=[name] 安装完成
FinishedLabelNoIcons=安装程序已在您的电脑中安装了 [name]。
FinishedLabel=安装程序已在您的电脑中安装了 [name]。%n%n单击“完成”退出安装程序。
ClickFinish=请单击“完成”退出安装程序。
FinishedRestartLabel=要完成 [name] 的安装，安装程序必须重新启动您的电脑。是否立即重新启动？
FinishedRestartMessage=要完成 [name] 的安装，安装程序必须重新启动您的电脑。%n%n是否立即重新启动？
LaunchProgram=启动 %1
LaunchProgramChecked=启动 %1(&L)

; ---- 卸载 ----
UninstallStatusLabel=正在从您的电脑中卸载 [name]，请稍候。
UninstalledAll=[name] 已成功从您的电脑中卸载。
UninstalledMost=[name] 卸载完成。%n%n有些元素未能卸载，您可以手动删除。
ConfirmUninstall=您确定要完全卸载 %1 及其所有组件吗？

; ---- 错误提示 ----
ErrorDiskSpace=安装程序需要至少 %.2f MB 的可用磁盘空间才能安装，但当前驱动器只有 %.2f MB 可用。%n%n请删除一些文件后重试，或选择其他驱动器。
ErrorCreatingDir=安装程序无法创建目录“%1”
ErrorTooManyFilesInDir2=安装程序无法创建目录“%1”，因为该目录中已存在 %2 个文件
ExitSetupTitle=退出安装
ExitSetupMessage=安装尚未完成。如果您现在退出，程序将不会被安装。%n%n您可以稍后再次运行安装程序以完成安装。%n%n现在退出安装吗？

; ---- 目录选择对话框 ----
SelectFolderDesc=选择文件夹
SelectFolderLabel=请选择安装文件夹，然后单击“确定”。
