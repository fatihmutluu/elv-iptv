<#
.SYNOPSIS
Locates MSYS2 MINGW64 bash and runs tools/mpv-runtime/build-windows.sh.

.EXAMPLE
.\tools\mpv-runtime\build-windows.ps1 -WorkDir C:\temp\mpv-build -OutDir C:\temp\mpv-out
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$WorkDir,

  [Parameter(Mandatory = $true, Position = 1)]
  [string]$OutDir,

  [Parameter(Mandatory = $false)]
  [string]$Msys2Root = $env:MSYS2_ROOT
)

$ErrorActionPreference = 'Stop'

$candidates = @()
if ($Msys2Root) { $candidates += $Msys2Root }
$candidates += 'C:\msys64', 'D:\msys64'

$bashExe = $null
foreach ($root in $candidates) {
  $candidate = Join-Path $root 'usr\bin\bash.exe'
  if (Test-Path -LiteralPath $candidate) {
    $bashExe = $candidate
    break
  }
}

if (-not $bashExe) {
  throw 'MSYS2 bash.exe not found. Install MSYS2 (https://www.msys2.org/) or set MSYS2_ROOT.'
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$buildScript = Join-Path $scriptDir 'build-windows.sh'

$env:MSYSTEM = 'MINGW64'
$env:CHERE_INVOKING = '1'
$env:ELV_BUILD_SCRIPT = $buildScript
$env:ELV_WORK_DIR = [System.IO.Path]::GetFullPath($WorkDir)
$env:ELV_OUT_DIR = [System.IO.Path]::GetFullPath($OutDir)

& $bashExe -lc 'exec bash "$(cygpath -u "$ELV_BUILD_SCRIPT")" "$(cygpath -u "$ELV_WORK_DIR")" "$(cygpath -u "$ELV_OUT_DIR")"'
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
