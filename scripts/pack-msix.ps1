<#
.SYNOPSIS
  Packs a TEST MSIX of Trove (plan 22.2.3): placeholder identity, self-signed, never for upload.

.DESCRIPTION
  Build the exe first, as the Store channel:
    $env:TROVE_CHANNEL = 'msstore'
    bun tauri build --no-bundle --config src-tauri/tauri.msix.conf.json
  Then:
    pwsh scripts/pack-msix.ps1                 # layout + .msix
    pwsh scripts/pack-msix.ps1 -Sign           # + a throwaway self-signed signature
    pwsh scripts/pack-msix.ps1 -Register       # install the layout (needs Developer Mode, no admin)
    pwsh scripts/pack-msix.ps1 -Unregister     # remove it again

  Uses the Windows SDK's makeappx / signtool when they are there. It never installs anything:
  without the SDK it says so and stops after the layout.
  A signed .msix only installs with Add-AppxPackage once its certificate is trusted in
  LocalMachine\TrustedPeople (admin). -Register skips that: Developer Mode installs the layout.
#>
param(
  [string]$Exe = '',
  [string]$Out = '',
  [ValidateSet('x64', 'arm64')][string]$Arch = 'x64',
  [switch]$Sign,
  [switch]$Register,
  [switch]$Unregister
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$name = 'TroveTest.Placeholder'

if ($Unregister) {
  $pkg = Get-AppxPackage -Name $name
  if ($pkg) { $pkg | Remove-AppxPackage; Write-Host "removed $($pkg.PackageFullName)" }
  else { Write-Host "$name is not installed" }
  if (Get-AppxPackage -Name $name) { throw "$name is still installed after Remove-AppxPackage" }
  exit 0
}

$target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $repo 'src-tauri/target' }
if (-not $Exe) { $Exe = Join-Path $target 'release/trove.exe' }
if (-not (Test-Path $Exe)) { throw "no exe at $Exe - build it first (see the help)" }
if (-not $Out) { $Out = Join-Path $target 'msix' }

# MSIX wants four parts; tauri.conf.json has three
$conf = Get-Content (Join-Path $repo 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$version = "$($conf.version).0"
if ($version -notmatch '^\d+\.\d+\.\d+\.0$') { throw "version '$version' is not x.y.z.0" }

$layout = Join-Path $Out 'layout'
if (Test-Path $layout) { Remove-Item -Recurse -Force $layout }
New-Item -ItemType Directory -Force (Join-Path $layout 'Assets') | Out-Null
Copy-Item $Exe (Join-Path $layout 'trove.exe')
$icons = Join-Path $repo 'src-tauri/icons'
foreach ($icon in 'Square150x150Logo', 'Square44x44Logo', 'Square71x71Logo', 'StoreLogo') {
  Copy-Item (Join-Path $icons "$icon.png") (Join-Path $layout "Assets/$icon.png")
}
$manifest = (Get-Content (Join-Path $repo 'src-tauri/msix/AppxManifest.xml') -Raw).
  Replace('{VERSION}', $version).Replace('{ARCH}', $Arch)
Set-Content -Path (Join-Path $layout 'AppxManifest.xml') -Value $manifest -Encoding utf8NoBOM
Write-Host "layout: $layout ($version, $Arch)"

if ($Register) {
  Get-AppxPackage -Name $name | Remove-AppxPackage
  Add-AppxPackage -Register (Join-Path $layout 'AppxManifest.xml')
  $pkg = Get-AppxPackage -Name $name
  if (-not $pkg) { throw 'Add-AppxPackage -Register returned but the package is not installed' }
  Write-Host "registered $($pkg.PackageFullName)"
  exit 0
}

# the newest SDK that has the tool; never installed from here
function Find-SdkTool([string]$tool) {
  $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
  if (-not (Test-Path $kits)) { return $null }
  Get-ChildItem $kits -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName "x64/$tool" } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
}

$makeappx = Find-SdkTool 'makeappx.exe'
if (-not $makeappx) {
  Write-Warning 'Windows SDK makeappx.exe not found: the layout is ready, no .msix made. Install the Windows 10/11 SDK to pack.'
  exit 2
}
$msix = Join-Path $Out "Trove-$version-$Arch-test.msix"
& $makeappx pack /o /d $layout /p $msix | Select-Object -Last 2
if ($LASTEXITCODE -ne 0) { throw "makeappx failed ($LASTEXITCODE)" }
Write-Host "packed: $msix"

if ($Sign) {
  $signtool = Find-SdkTool 'signtool.exe'
  if (-not $signtool) { Write-Warning 'signtool.exe not found: left unsigned'; exit 2 }
  # a throwaway code-signing cert whose subject matches the manifest Publisher
  $cert = New-SelfSignedCertificate -Type Custom -Subject 'CN=Trove Test Placeholder' `
    -KeyUsage DigitalSignature -FriendlyName 'Trove MSIX test (throwaway)' `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
  try {
    $pfx = Join-Path $Out 'trove-test.pfx'
    $pass = [guid]::NewGuid().ToString('N')
    $secure = ConvertTo-SecureString $pass -AsPlainText -Force
    Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $secure | Out-Null
    Export-Certificate -Cert $cert -FilePath (Join-Path $Out 'trove-test.cer') | Out-Null
    & $signtool sign /fd SHA256 /f $pfx /p $pass $msix | Select-Object -Last 2
    if ($LASTEXITCODE -ne 0) { throw "signtool failed ($LASTEXITCODE)" }
    Remove-Item $pfx
    Write-Host "signed: $msix (cert: $(Join-Path $Out 'trove-test.cer'))"
  }
  finally {
    Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)"
  }
}
