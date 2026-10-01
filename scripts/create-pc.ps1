param([string]$Name = 'interstellar-pc-01', [string]$Location = 'mexicocentral')
$ErrorActionPreference = 'Stop'
$az = 'C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd'
$private = Join-Path $PSScriptRoot '../.wrangler'
New-Item -ItemType Directory -Force $private | Out-Null
$credentialsPath = Join-Path $private "$Name.json"
if (Test-Path $credentialsPath) { $pc = Get-Content $credentialsPath -Raw | ConvertFrom-Json }
else {
    $pc = [ordered]@{ name=$Name; location=$Location; username='pcadmin'; password=('Pc!' + [guid]::NewGuid().ToString('N')); gatewayKey=([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')); invitation=[guid]::NewGuid().ToString('N'); dns=($Name + '-' + [guid]::NewGuid().ToString('N').Substring(0,8)) }
    $pc | ConvertTo-Json | Set-Content $credentialsPath
}
# No public RDP/VNC. Only the authenticated HTTPS desktop gateway is exposed.
& $az vm create --resource-group interstellar-pcs --name $pc.name --computer-name InterstellarPC --location $pc.location --image MicrosoftWindowsDesktop:Windows-10:win10-22h2-pro-g2:latest --size Standard_B2as_v2 --admin-username $pc.username --admin-password $pc.password --license-type Windows_Client --storage-sku StandardSSD_LRS --security-type TrustedLaunch --enable-secure-boot true --enable-vtpm true --public-ip-sku Standard --public-ip-address-dns-name $pc.dns --nsg-rule NONE --tags project=Interstellar --output json > (Join-Path $private "$Name-deployment.json")
if ($LASTEXITCODE -ne 0) { throw 'VM creation failed. See the Azure error above.' }
& $az vm open-port --resource-group interstellar-pcs --name $pc.name --port 80,443 --priority 1000 --output none
if ($LASTEXITCODE -ne 0) { throw 'Could not enable HTTPS.' }
Write-Output 'Windows VM created. Credentials are in the ignored .wrangler folder.'

