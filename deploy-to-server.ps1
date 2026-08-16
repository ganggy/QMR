param(
    [Parameter(Mandatory = $true)]
    [string]$Server,
    [switch]$Configure,
    [string]$HosxpHost = '192.168.2.254',
    [string]$HosxpDatabase = 'hos',
    [string]$HosxpUser = 'opd'
)

$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectPath

$archive = Join-Path $env:TEMP 'qmr-kss-deploy.tar.gz'
$temporaryEnv = $null
$serverHost = ($Server -split '@')[-1]
$release = (& git rev-parse HEAD).Trim()
if (-not $release) { throw 'Cannot determine the Git release SHA.' }

Write-Host 'Checking project...' -ForegroundColor Cyan
& npm.cmd run check
if ($LASTEXITCODE -ne 0) { throw 'Project check failed.' }

if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }

Write-Host 'Building deployment archive...' -ForegroundColor Cyan
& tar.exe -czf $archive --format=ustar `
    --exclude='./node_modules' `
    --exclude='./.git' `
    --exclude='./.venv' `
    --exclude='./__pycache__' `
    --exclude='./qmr.db*' `
    --exclude='./uploads' `
    --exclude='./.env' `
    --exclude='./deploy-to-server.ps1' `
    .
if ($LASTEXITCODE -ne 0) { throw 'Could not build deployment archive.' }

try {
    if ($Configure) {
        function Read-PlainSecret([string]$Prompt) {
            $secureValue = Read-Host $Prompt -AsSecureString
            $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
            try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
            finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        }
        function ConvertTo-EnvValue([string]$Value) {
            if ($Value.Contains("`r") -or $Value.Contains("`n")) { throw 'Environment values cannot contain a new line.' }
            return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
        }

        $hosxpPassword = Read-PlainSecret 'HOSxP database password'
        $adminPassword = Read-PlainSecret 'Set QMR web administrator password (minimum 12 characters)'
        $adminConfirm = Read-PlainSecret 'Confirm QMR web administrator password'
        if ($adminPassword.Length -lt 12) { throw 'QMR administrator password must contain at least 12 characters.' }
        if ($adminPassword -cne $adminConfirm) { throw 'QMR administrator passwords do not match.' }

        $secretBytes = New-Object byte[] 48
        $randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $randomGenerator.GetBytes($secretBytes) }
        finally { $randomGenerator.Dispose() }
        $qmrSecret = [Convert]::ToBase64String($secretBytes)

        $temporaryEnv = Join-Path $env:TEMP 'qmr-kss.env'
        if (Test-Path -LiteralPath $temporaryEnv) { Remove-Item -LiteralPath $temporaryEnv -Force }
        $utf8NoBom = New-Object Text.UTF8Encoding($false)
        $envLines = @(
            "HOSXP_HOST=$(ConvertTo-EnvValue $HosxpHost)",
            'HOSXP_PORT=3306',
            "HOSXP_DATABASE=$(ConvertTo-EnvValue $HosxpDatabase)",
            "HOSXP_USER=$(ConvertTo-EnvValue $HosxpUser)",
            "HOSXP_PASSWORD=$(ConvertTo-EnvValue $hosxpPassword)",
            'QMR_ADMIN_USER=admin',
            "QMR_ADMIN_PASSWORD=$(ConvertTo-EnvValue $adminPassword)",
            "QMR_SECRET_KEY=$(ConvertTo-EnvValue $qmrSecret)",
            'QMR_ALLOW_REGISTRATION=1',
            'QMR_SECURE_COOKIE=0'
        )
        [IO.File]::WriteAllLines($temporaryEnv, $envLines, $utf8NoBom)
    }

    $uploadFiles = @($archive, (Join-Path $projectPath 'qmr-remote-install.sh'))
    if ($Configure) { $uploadFiles += $temporaryEnv }
    Write-Host 'Uploading deployment files. Enter the SSH password when prompted.' -ForegroundColor Yellow
    & scp.exe @uploadFiles "${Server}:/tmp/"
    if ($LASTEXITCODE -ne 0) { throw 'Upload failed.' }

    Write-Host 'Installing on server. Enter the SSH password and sudo password when prompted.' -ForegroundColor Yellow
    & ssh.exe -tt $Server "bash /tmp/qmr-remote-install.sh $release"
    if ($LASTEXITCODE -ne 0) { throw "Remote deployment failed with exit code $LASTEXITCODE." }
    else {
        $version = Invoke-RestMethod -Uri "http://${serverHost}:3509/api/version" -TimeoutSec 10
        if ($version.service -ne 'qmr-kss' -or $version.release -ne $release) {
            throw "Deployment verification failed. Expected $release but server reported $($version.release)."
        }
        Write-Host "Deployment verified: $($version.release)" -ForegroundColor Green
        Write-Host "Application URL: http://${serverHost}:3509" -ForegroundColor Green
    }
}
finally {
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
    if ($temporaryEnv -and (Test-Path -LiteralPath $temporaryEnv)) { Remove-Item -LiteralPath $temporaryEnv -Force }
}
