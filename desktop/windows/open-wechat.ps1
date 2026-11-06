param([switch]$Control)
$ErrorActionPreference = 'Stop'
$LocalPort = 13390
$LocalUrl = "http://127.0.0.1:$LocalPort/"
$SshTarget = 'DEPLOY_USER@SERVER'
$SshProcess = $null

function Test-TunnelPort {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect('127.0.0.1', $LocalPort)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Open-WechatPage {
    $edgePaths = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
    )
    $edge = $edgePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($edge) {
        Start-Process -FilePath $edge -ArgumentList @('--new-window', $LocalUrl)
    } else {
        Start-Process $LocalUrl
    }
}

try {
    Write-Host '打开阮阮微信：网页连接后自动人工接管。' -ForegroundColor Cyan
    Write-Host "固定入口：$LocalUrl"
    Write-Host '请先连接 Tailscale。网页使用原来的远程桌面账号和密码登录。'
    Write-Host '关闭最后一个远程页面，阮阮会自动恢复操作；不用再点接管或恢复按钮。'
    Write-Host ''

    if (Test-TunnelPort) {
        Write-Host '检测到已有本地入口，正在打开网页。请保持原 SSH 连接窗口运行。'
        Open-WechatPage
        exit 0
    }

    $ssh = Get-Command ssh.exe -ErrorAction SilentlyContinue
    if (-not $ssh) {
        throw '没有找到 Windows OpenSSH 客户端。请在 Windows 可选功能中安装 OpenSSH 客户端。'
    }
    Write-Host '正在建立连接；首次可能需要确认服务器指纹或输入 SSH 密码。'
    $sshArguments = @(
        '-N', '-T',
        '-L', "127.0.0.1:${LocalPort}:127.0.0.1:3290",
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=10',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'ConnectTimeout=15',
        $SshTarget
    )
    $SshProcess = Start-Process -FilePath $ssh.Source -ArgumentList $sshArguments -NoNewWindow -PassThru
    $deadline = (Get-Date).AddMinutes(3)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        $SshProcess.Refresh()
        if ($SshProcess.HasExited) {
            throw 'SSH 连接已退出。请确认 Tailscale 已连接、服务器可达，并查看上方 SSH 提示。'
        }
        if (Test-TunnelPort) {
            $ready = $true
            break
        }
        Start-Sleep -Milliseconds 300
    }
    if (-not $ready) { throw '等待连接超时，请重新运行并完成 SSH 登录。' }
    Open-WechatPage
    Write-Host ''
    Write-Host '网页已打开。远程使用期间请保留此连接窗口。' -ForegroundColor Green
    Write-Host '关闭网页即可归还自动操作；关闭本窗口也会断开远程连接。'
    Write-Host "请使用上面显示的地址：$LocalUrl"
    $SshProcess.WaitForExit()
    Write-Host 'SSH 连接已断开。'
} catch {
    Write-Host ''
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    if ($SshProcess -and -not $SshProcess.HasExited) {
        Stop-Process -Id $SshProcess.Id -ErrorAction SilentlyContinue
    }
}
