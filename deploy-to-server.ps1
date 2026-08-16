param(
    [Parameter(Mandatory = $true)]
    [string]$Server,
    [string]$RemoteRoot = '/opt/qmr',
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
OLD_ROOT='/opt/qrm'
NEW_ROOT='/opt/qmr'
if [ "$OLD_ROOT" != '/opt/qrm' ] || [ "$NEW_ROOT" != '/opt/qmr' ]; then
  echo 'ERROR: Deployment path safety check failed.'
  exit 25
fi
echo 'Removing retired /opt/qrm and preparing /opt/qmr (sudo permission may be requested)...'
sudo -v
old_apps=$(pm2 jlist | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{for(const p of JSON.parse(d||'[]')){const e=p.pm2_env||{};if((e.pm_cwd||'').startsWith('/opt/qrm')||(e.pm_exec_path||'').startsWith('/opt/qrm'))console.log(p.name)}})")
for old_app in $old_apps; do
  echo "Stopping retired PM2 app: $old_app"
  pm2 delete "$old_app"
done
for cwd_link in /proc/[0-9]*/cwd; do
  process_cwd=$(readlink "$cwd_link" 2>/dev/null || true)
  case "$process_cwd" in
    /opt/qrm|/opt/qrm/*)
      process_pid=$(echo "$cwd_link" | cut -d/ -f3)
      echo "Stopping retired process PID $process_pid from $process_cwd"
      sudo kill "$process_pid" 2>/dev/null || true
      ;;
  esac
done
sleep 1
sudo rm -rf -- "$OLD_ROOT"
sudo mkdir -p "$NEW_ROOT/data/uploads" "$NEW_ROOT/logs"
sudo chown -R "$(id -un):$(id -gn)" "$NEW_ROOT"
tar -xzf /tmp/qmr-kss-deploy.tar.gz -C "$NEW_ROOT"
rm -f /tmp/qmr-kss-deploy.tar.gz
cd "$NEW_ROOT"
node_major=$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)
if [ "$node_major" -lt 22 ]; then
  echo "ERROR: Node.js 22 or newer is required. Current: $(node --version 2>/dev/null || echo missing)"
  exit 22
fi
npm ci --omit=dev
if [ -f /tmp/qmr-kss.env ]; then
  mv /tmp/qmr-kss.env "$NEW_ROOT/.env"
  chmod 600 "$NEW_ROOT/.env"
fi
if [ ! -f .env ]; then
  cp .env.production.example .env
  chmod 600 .env
  echo "FIRST_SETUP_REQUIRED"
  echo "Edit /opt/qmr/.env, then run: cd /opt/qmr && pm2 start ecosystem.config.cjs && pm2 save"
  exit 23
fi
chmod 600 .env
printf '%s\n' '__QMR_RELEASE__' > "$NEW_ROOT/.release"
if command -v ss >/dev/null 2>&1 && ss -ltn | grep -q ':3509 '; then
  echo 'ERROR: TCP port 3509 is still used after removing /opt/qrm processes.'
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
        Write-Host 'Code deployed. Configure /opt/qmr/.env on the server, then start PM2.' -ForegroundColor Yellow
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
