$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectPath

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js was not found. Please install Node.js 22 or newer.'
}

& npm.cmd install

if (-not $env:HOSXP_PASSWORD) {
    $securePassword = Read-Host 'HOSxP password (read-only account)' -AsSecureString
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try { $env:HOSXP_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer) }
}
if (-not $env:QMR_ADMIN_PASSWORD) {
    $secureAdminPassword = Read-Host 'Set QMR administrator password' -AsSecureString
    $adminPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureAdminPassword)
    try { $adminPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($adminPointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($adminPointer) }

    $secureAdminConfirm = Read-Host 'Confirm QMR administrator password' -AsSecureString
    $confirmPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureAdminConfirm)
    try { $adminConfirm = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($confirmPointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($confirmPointer) }

    if ([string]::IsNullOrWhiteSpace($adminPassword)) {
        throw 'QMR administrator password cannot be empty.'
    }
    if ($adminPassword -cne $adminConfirm) {
        throw 'QMR administrator passwords do not match. Please run start.ps1 again.'
    }
    $env:QMR_ADMIN_PASSWORD = $adminPassword
}
if (-not $env:QMR_SECRET_KEY) {
    # Compatible with Windows PowerShell 5.1 / .NET Framework and PowerShell 7.
    $secretBytes = New-Object byte[] 48
    $randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $randomGenerator.GetBytes($secretBytes)
        $env:QMR_SECRET_KEY = [Convert]::ToBase64String($secretBytes)
    }
    finally {
        $randomGenerator.Dispose()
    }
}
$env:QMR_DEMO_MODE = '0'
$env:QMR_HOST = '0.0.0.0'
$env:QMR_PORT = '3509'
# The application is currently served over HTTP on the hospital LAN.
# A Secure cookie would be rejected by browsers on an http:// IP address.
$env:QMR_SECURE_COOKIE = '0'

$localIps = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress

Write-Host ''
Write-Host 'Web login username: admin' -ForegroundColor Yellow
Write-Host 'This computer: http://localhost:3509' -ForegroundColor Green
foreach ($localIp in $localIps) {
    Write-Host "Phone/tablet: http://${localIp}:3509" -ForegroundColor Cyan
}
Write-Host ''
& npm.cmd start
