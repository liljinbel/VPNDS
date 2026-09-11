$localApp = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$torDir = Join-Path $localApp 'GoLiveBypass\Tor'
$torExe = Join-Path $torDir 'tor\tor.exe'
$torrc = Join-Path $torDir 'torrc'
$vbs = Join-Path $torDir 'GoLiveBypassTor.vbs'

$innerCommand = "`"$torExe`" -f `"$torrc`"".Replace('"', '""')
$vbsScript = "CreateObject(`"WScript.Shell`").Run `"$innerCommand`", 0, False"

[IO.File]::WriteAllText($vbs, $vbsScript, [Text.Encoding]::Unicode)

$command = "wscript.exe `"$vbs`""
Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'GoLiveBypassTor' -Value $command

# Certifica que o VBS funciona executando agora
Start-Process -FilePath "wscript.exe" -ArgumentList "`"$vbs`""

Start-Sleep -Seconds 2

$reg = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'GoLiveBypassTor'
Write-Output "StartupRegistered: $($reg.GoLiveBypassTor)"

$client = New-Object System.Net.Sockets.TcpClient
$task = $client.ConnectAsync('127.0.0.1', 9060)
if ($task.Wait(2000) -and $client.Connected) {
    Write-Output "TorReadyPort9060"
    $client.Close()
}
