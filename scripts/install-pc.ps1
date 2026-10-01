param([string]$Name = 'interstellar-pc-01')
$ErrorActionPreference = 'Stop'
$private = Join-Path $PSScriptRoot '../.wrangler'
$pc = Get-Content (Join-Path $private "$Name.json") -Raw | ConvertFrom-Json
$config = @{hostname="$($pc.dns).$($pc.location).cloudapp.azure.com";gatewayKey=$pc.gatewayKey;username=$pc.username;password=$pc.password} | ConvertTo-Json -Compress
$files = @{'setup.json'=$config; 'pc-gateway.cjs'=(Get-Content "$PSScriptRoot/pc-gateway.cjs" -Raw); 'setup.ps1'=(Get-Content "$PSScriptRoot/setup-pc.ps1" -Raw)}
$script = "New-Item -ItemType Directory -Force C:\Interstellar | Out-Null`n"
foreach ($entry in $files.GetEnumerator()) {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($entry.Value))
    $script += "[IO.File]::WriteAllBytes('C:\Interstellar\$($entry.Key)', [Convert]::FromBase64String('$encoded'))`n"
}
$script += "& C:\Interstellar\setup.ps1"
$scriptPath = Join-Path $private "$Name-install.ps1"
$script | Set-Content $scriptPath
$result = & 'C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd' vm run-command invoke --resource-group interstellar-pcs --name $Name --command-id RunPowerShellScript --scripts "@$scriptPath" --query 'value[].message' -o json
if ($LASTEXITCODE -ne 0 -or ($result -join "`n") -notmatch 'INTERSTELLAR_SETUP_OK') { $result; throw 'Windows setup failed.' }
Write-Output 'Desktop installed. Restart the VM to complete Windows sign-in.'
