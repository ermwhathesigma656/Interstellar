# Run inside the Azure Windows VM as SYSTEM. Config and gateway files are supplied privately by install-pc.ps1.
$ErrorActionPreference = 'Stop'
$root = 'C:\Interstellar'
$config = Get-Content "$root\setup.json" -Raw | ConvertFrom-Json
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest 'https://www.tightvnc.com/download/2.8.88/tightvnc-2.8.88-gpl-setup-64bit.msi' -OutFile "$root\tightvnc.msi" -UseBasicParsing
$msi = Start-Process msiexec.exe -ArgumentList @('/i', "$root\tightvnc.msi", '/quiet', '/norestart', 'ADDLOCAL=Server', 'SERVER_REGISTER_AS_SERVICE=1', 'SERVER_ADD_FIREWALL_EXCEPTION=0', 'SET_ALLOWLOOPBACK=1', 'VALUE_OF_ALLOWLOOPBACK=1', 'SET_LOOPBACKONLY=1', 'VALUE_OF_LOOPBACKONLY=1', 'SET_ACCEPTHTTPCONNECTIONS=1', 'VALUE_OF_ACCEPTHTTPCONNECTIONS=0', 'SET_USEVNCAUTHENTICATION=1', 'VALUE_OF_USEVNCAUTHENTICATION=0', 'SET_NEVERSHARED=1', 'VALUE_OF_NEVERSHARED=1', 'SET_DISCONNECTCLIENTS=1', 'VALUE_OF_DISCONNECTCLIENTS=0') -PassThru -Wait -WindowStyle Hidden
if ($msi.ExitCode -notin @(0,3010)) { throw "TightVNC installer failed: $($msi.ExitCode)" }
Invoke-WebRequest 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip' -OutFile "$root\node.zip" -UseBasicParsing
Expand-Archive "$root\node.zip" -DestinationPath $root -Force
Invoke-WebRequest 'https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_windows_amd64.zip' -OutFile "$root\caddy.zip" -UseBasicParsing
Expand-Archive "$root\caddy.zip" -DestinationPath "$root\caddy" -Force
Set-Location $root
& "$root\node-v24.21.0-win-x64\npm.cmd" install --omit=dev --ignore-scripts ws@8.18.3
if ($LASTEXITCODE -ne 0) { throw 'WebSocket gateway installation failed.' }
@{key=$config.gatewayKey;downloads="C:/Users/$($config.username)/Downloads"} | ConvertTo-Json | Set-Content "$root\gateway.json" -Encoding ASCII
"$($config.hostname) {`n reverse_proxy 127.0.0.1:6080`n}" | Set-Content "$root\Caddyfile" -Encoding ASCII
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName InterstellarGateway -Action (New-ScheduledTaskAction -Execute "$root\node-v24.21.0-win-x64\node.exe" -Argument "$root\pc-gateway.cjs" -WorkingDirectory $root) -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Register-ScheduledTask -TaskName InterstellarHTTPS -Action (New-ScheduledTaskAction -Execute "$root\caddy\caddy.exe" -Argument "run --config $root\Caddyfile --adapter caddyfile" -WorkingDirectory $root) -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
New-NetFirewallRule -DisplayName 'Interstellar HTTPS' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 80,443 -ErrorAction SilentlyContinue | Out-Null
# Dedicated per-account VM: sign into its own desktop after boot. Secrets stay inside that VM.
$winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Set-ItemProperty $winlogon AutoAdminLogon '1'
Set-ItemProperty $winlogon DefaultUserName $config.username
Set-ItemProperty $winlogon DefaultPassword $config.password
Set-ItemProperty $winlogon DefaultDomainName $env:COMPUTERNAME
$system = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
Set-ItemProperty $system EnableFirstLogonAnimation 0
$oobe = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\OOBE'
if (!(Test-Path $oobe)) { New-Item $oobe | Out-Null }
New-ItemProperty $oobe PrivacyConsentStatus -Value 1 -PropertyType DWord -Force | Out-Null
$oobePolicy = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\OOBE'
if (!(Test-Path $oobePolicy)) { New-Item $oobePolicy -Force | Out-Null }
New-ItemProperty $oobePolicy DisablePrivacyExperience -Value 1 -PropertyType DWord -Force | Out-Null
$edgePolicy = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
if (!(Test-Path $edgePolicy)) { New-Item $edgePolicy -Force | Out-Null }
New-ItemProperty $edgePolicy HideFirstRunExperience -Value 1 -PropertyType DWord -Force | Out-Null
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
New-ItemProperty 'HKLM:\SOFTWARE\TightVNC\Server' PollingInterval -Value 100 -PropertyType DWord -Force | Out-Null
New-ItemProperty 'HKLM:\SOFTWARE\TightVNC\Server' IdleTimeout -Value 0 -PropertyType DWord -Force | Out-Null
# Guest files are only readable by administrators and SYSTEM.
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $identity = New-Object System.Security.Principal.SecurityIdentifier($sid)
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
}
Set-Acl -LiteralPath $root -AclObject $acl
Start-ScheduledTask InterstellarGateway
Start-ScheduledTask InterstellarHTTPS
Remove-Item -LiteralPath "$root\setup.json"
Write-Output 'INTERSTELLAR_SETUP_OK: Restart Windows to enter the desktop.'
