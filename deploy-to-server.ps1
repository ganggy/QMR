param(
    [Parameter(Mandatory = $true)]
    [string]$Server,
    [string]$RemoteRoot = '/opt/qrm',
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
& tar.exe -czf $archive `
    --exclude='./node_modules' `
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

        $temporaryEnv = [IO.Path]::GetTempFileName()
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

    Write-Host 'Uploading package. Enter the SSH password when prompted.' -ForegroundColor Yellow
    & scp.exe $archive "${Server}:/tmp/qmr-kss-deploy.tar.gz"
    if ($LASTEXITCODE -ne 0) { throw 'Upload failed.' }
    if ($Configure) {
        Write-Host 'Uploading production configuration. Enter the SSH password when prompted.' -ForegroundColor Yellow
        & scp.exe $temporaryEnv "${Server}:/tmp/qmr-kss.env"
        if ($LASTEXITCODE -ne 0) { throw 'Configuration upload failed.' }
    }

    Write-Host 'Installing on server. Enter the SSH password again when prompted.' -ForegroundColor Yellow
    $remoteCommand = @'
set -e
echo 'Preparing /opt/qrm (sudo permission may be requested)...'
sudo -v
sudo mkdir -p /opt/qrm /opt/qrm/data/uploads /opt/qrm/logs
sudo chown -R "$(id -un):$(id -gn)" /opt/qrm
tar -xzf /tmp/qmr-kss-deploy.tar.gz -C /opt/qrm
rm -f /tmp/qmr-kss-deploy.tar.gz
cd /opt/qrm
node_major=$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)
if [ "$node_major" -lt 22 ]; then
  echo "ERROR: Node.js 22 or newer is required. Current: $(node --version 2>/dev/null || echo missing)"
  exit 22
fi
npm ci --omit=dev
if [ -f /tmp/qmr-kss.env ]; then
  mv /tmp/qmr-kss.env /opt/qrm/.env
  chmod 600 /opt/qrm/.env
fi
if [ ! -f .env ]; then
  cp .env.production.example .env
  chmod 600 .env
  echo "FIRST_SETUP_REQUIRED"
  echo "Edit /opt/qrm/.env, then run: cd /opt/qrm && pm2 start ecosystem.config.cjs && pm2 save"
  exit 23
fi
chmod 600 .env
printf '%s\n' '__QMR_RELEASE__' > /opt/qrm/.release
old_apps=$(pm2 jlist | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{for(const p of JSON.parse(d||'[]')){if(p.name!=='qmr-kss'&&p.pm2_env&&p.pm2_env.pm_cwd==='/opt/qrm')console.log(p.name)}})")
for old_app in $old_apps; do
  echo "Replacing old PM2 app in /opt/qrm: $old_app"
  pm2 delete "$old_app"
done
if command -v ss >/dev/null 2>&1 && ss -ltn | grep -q ':3509 '; then
  echo 'ERROR: TCP port 3509 is still used by a process outside /opt/qrm.'
  ss -ltnp | grep ':3509 ' || true
  exit 24
fi
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
pm2 status qmr-kss
'@
    $remoteCommand = $remoteCommand.Replace('__QMR_RELEASE__', $release)
    & ssh.exe -tt $Server $remoteCommand
    if ($LASTEXITCODE -eq 23) {
        Write-Host 'Code deployed. Configure /opt/qrm/.env on the server, then start PM2.' -ForegroundColor Yellow
    }
    elseif ($LASTEXITCODE -ne 0) { throw "Remote deployment failed with exit code $LASTEXITCODE." }
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
