$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

function Refresh-WqPath {
    $env:Path = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), $env:Path, (Join-Path $env:USERPROFILE '.local\bin')) -join ';'
}

function Find-WqEgoCli {
    Refresh-WqPath
    foreach ($name in @('ego-browser.exe', 'ego-browser.cmd', 'ego-browser.bat', 'ego-browser.ps1')) {
        $command = Get-Command $name -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { return $command.Source }
    }
    return $null
}

function Find-WqEgoBrowser {
    $entries = @()
    foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
        $entries += @(Get-ItemProperty $key -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '(?i)^ego(?:\b|lite)' -and $_.DisplayName -notmatch '(?i)updat' -and (!$_.Publisher -or $_.Publisher -match '(?i)citro') })
    }
    foreach ($entry in $entries) {
        $paths = @()
        if ($entry.DisplayIcon) {
            $icon = [string]$entry.DisplayIcon
            if ($icon -match '^"([^"]+)"') { $paths += $matches[1] } else { $paths += ($icon -replace ',\s*-?\d+$', '') }
        }
        if ($entry.InstallLocation) {
            foreach ($relative in @('ego.exe', 'Application\ego.exe', 'egolite.exe', 'Application\egolite.exe')) { $paths += Join-Path $entry.InstallLocation $relative }
        }
        foreach ($file in $paths) {
            if (Test-Path -LiteralPath $file -PathType Leaf) {
                $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($file)
                if ($version.ProductName -match '(?i)ego' -and $version.ProductName -notmatch '(?i)updater') { return [pscustomobject]@{ Path = $file; Version = $version.ProductVersion; Name = $entry.DisplayName } }
            }
        }
    }
    foreach ($hive in @('HKCU:', 'HKLM:')) {
        $key = Join-Path $hive 'Software\Microsoft\Windows\CurrentVersion\App Paths\ego.exe'
        if (Test-Path $key) {
            $file = (Get-Item $key).GetValue('')
            if ($file -and (Test-Path -LiteralPath $file -PathType Leaf)) { return [pscustomobject]@{ Path = $file; Version = [Diagnostics.FileVersionInfo]::GetVersionInfo($file).ProductVersion; Name = 'ego' } }
        }
    }
    if ($entries.Count -gt 0) { return [pscustomobject]@{ Path = $null; Version = $entries[0].DisplayVersion; Name = $entries[0].DisplayName } }
    return $null
}

function Install-WqEgo {
    $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'environment-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $installer = Join-Path $PSScriptRoot ('environment\' + $manifest.egoInstaller.file)
    if (!(Test-Path -LiteralPath $installer -PathType Leaf)) { throw '缺少随包的Ego安装程序，请重新完整解压交付包。' }
    if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $manifest.egoInstaller.sha256) { throw 'Ego安装程序校验失败，请重新复制完整交付包。' }
    Write-Host ('未检测到Ego，启动随包安装程序（版本 ' + $manifest.egoInstaller.version + '）。安装引导器可能需要联网。')
    $process = Start-Process -FilePath $installer -PassThru -Wait
    if ($process.ExitCode -eq 3010) { throw 'Ego安装要求重启Windows；重启后再次运行一键配置环境。' }
    if ($process.ExitCode -ne 0) { throw ('Ego安装未完成，退出码：' + $process.ExitCode) }
}

function Ensure-WqEgo {
    $browser = Find-WqEgoBrowser
    $cli = Find-WqEgoCli
    if (!$browser -and !$cli) { Install-WqEgo; $browser = Find-WqEgoBrowser; $cli = Find-WqEgoCli }
    if ($browser) { Write-Host ('检测到Ego：' + $browser.Name + '，版本：' + $browser.Version) }
    if (!$cli) {
        if ($browser -and $browser.Path) { Start-Process -FilePath $browser.Path | Out-Null }
        Write-Host '请在Ego窗口完成首次引导；若窗口未打开，请从开始菜单打开ego。无需安装Codex或系统Node.js。'
        Read-Host '完成首次引导后按回车继续检测；也可以关闭此窗口，稍后重新运行' | Out-Null
        $browser = Find-WqEgoBrowser
        $cli = Find-WqEgoCli
    }
    if (!$cli) { throw 'Ego命令仍未注册。请完成Ego首次引导，再重新运行本CMD。未将环境标记为就绪。' }
    return [pscustomobject]@{ Executable = $cli; Browser = $browser }
}

function Invoke-WqEnvironmentSetup {
    if (![Environment]::Is64BitOperatingSystem -or [Environment]::OSVersion.Version.Major -lt 10) { throw '此交付包只支持64位Windows 10或Windows 11。' }
    $exe = Join-Path $PSScriptRoot '文青尚品.exe'
    $probe = Join-Path $PSScriptRoot 'resources\app\desktop\check-environment.mjs'
    if (!(Test-Path -LiteralPath $exe) -or !(Test-Path -LiteralPath $probe)) { throw '请先完整解压交付包，不能只复制exe或在压缩包内运行。' }
    $dataRoot = Join-Path $env:APPDATA '文青尚品'
    if (Test-Path -LiteralPath (Join-Path $dataRoot 'app-run.lock')) { throw '文青尚品有运行任务，请完成当前任务并退出App后再配置环境。' }
    $logs = Join-Path $env:LOCALAPPDATA 'WenqingShangpin\SetupLogs'
    New-Item -ItemType Directory -Force -Path $logs | Out-Null
    $logFile = Join-Path $logs ('setup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
    Start-Transcript -Path $logFile | Out-Null
    try {
        $os = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
        $label = if ([int]$os.CurrentBuildNumber -ge 22000) { 'Windows 11' } else { 'Windows 10' }
        Write-Host ($label + ' 64位，系统版本 ' + $os.CurrentBuildNumber + '；文青尚品版本 ' + [Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductVersion)
        $ego = Ensure-WqEgo
        New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        $oldNode = $env:ELECTRON_RUN_AS_NODE
        $oldPreference = $ErrorActionPreference
        try {
            $env:ELECTRON_RUN_AS_NODE = '1'
            $ErrorActionPreference = 'Continue'
            $output = @(& $exe $probe --probe-ego $ego.Executable 2>&1)
            $code = $LASTEXITCODE
        } finally {
            [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $oldNode, 'Process')
            $ErrorActionPreference = $oldPreference
        }
        $output | ForEach-Object { Write-Host ([string]$_) }
        $resultLine = $output | ForEach-Object { [string]$_ } | Where-Object { $_.StartsWith('WQ_ENV_RESULT ') } | Select-Object -Last 1
        if (!$resultLine) { throw 'App运行时未返回环境检查结果。请查看日志，不要直接开始上品。' }
        $result = $resultLine.Substring(14) | ConvertFrom-Json
        if ($code -ne 0 -or !$result.ok) { throw ('环境未就绪：' + $result.error) }
        if ($result.platform -ne 'win32' -or $result.arch -ne 'x64') { throw '运行时不是Windows x64，请使用完整64位交付包。' }
        $binding = Join-Path $dataRoot 'ego-runtime.json'
        if (Test-Path -LiteralPath $binding) { Copy-Item -LiteralPath $binding -Destination ($binding + '.backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
        $record = @{ schema = 1; executable = $result.executable; browser = $ego.Browser; configuredAt = (Get-Date).ToUniversalTime().ToString('o') }
        [IO.File]::WriteAllText(($binding + '.tmp'), ($record | ConvertTo-Json -Depth 5), $utf8)
        Move-Item -LiteralPath ($binding + '.tmp') -Destination $binding -Force
        [IO.File]::WriteAllText((Join-Path $logs 'latest-result.json'), ($result | ConvertTo-Json -Depth 5), $utf8)
        & (Join-Path $PSScriptRoot 'install-shortcuts.ps1')
        $configFile = Join-Path $dataRoot 'config.json'
        if (!(Test-Path -LiteralPath $configFile)) {
            $sampleRoot = Join-Path $PSScriptRoot '拼多多模板素材库'
            $initial = @{ schema = 1; platform = 'pdd'; materialRoots = @{ pdd = $sampleRoot }; materialsRoot = $sampleRoot; shops = @(); selectedShopIds = @(); selectedProductIds = @() }
            [IO.File]::WriteAllText($configFile, ($initial | ConvertTo-Json -Depth 5), $utf8)
        }
        Write-Host ('环境检查通过。日志：' + $logFile) -ForegroundColor Green
        Write-Host '商家账号仍需在Ego中人工登录，再返回文青尚品核对店铺。'
        Start-Process -FilePath $exe | Out-Null
    } catch {
        $failure = @{ ok = $false; error = $_.Exception.Message; log = $logFile; at = (Get-Date).ToUniversalTime().ToString('o') }
        [IO.File]::WriteAllText((Join-Path $logs 'latest-result.json'), ($failure | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
        Write-Host ('配置失败：' + $_.Exception.Message) -ForegroundColor Red
        throw
    } finally { Stop-Transcript | Out-Null }
}

if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-WqEnvironmentSetup; exit 0 }
    catch { Write-Host ('配置失败：' + $_.Exception.Message) -ForegroundColor Red; exit 1 }
}
