param(
    [switch]$InstallDependencies,
    [int]$StartupTimeoutSeconds = 45
)

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot
$backendDir = Join-Path $repoRoot 'backend'
$frontendDir = Join-Path $repoRoot 'frontend'
$apiLog = Join-Path $env:TEMP 'airguard-api.log'
$apiErrorLog = Join-Path $env:TEMP 'airguard-api-error.log'
$webLog = Join-Path $env:TEMP 'airguard-web.log'
$webErrorLog = Join-Path $env:TEMP 'airguard-web-error.log'

function Test-HttpEndpoint([string]$Uri) {
    try {
        $null = Invoke-WebRequest -Uri $Uri -TimeoutSec 2 -UseBasicParsing
        return $true
    } catch {
        return $false
    }
}

function Resolve-PythonRuntime {
    $candidates = [System.Collections.Generic.List[string]]::new()
    foreach ($path in @(
        (Join-Path $repoRoot '.venv\Scripts\python.exe'),
        (Join-Path $backendDir '.venv\Scripts\python.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
        (Join-Path $env:ProgramFiles 'Python311\python.exe'),
        (Join-Path $env:ProgramFiles 'Python312\python.exe')
    )) {
        if (Test-Path -LiteralPath $path) { $candidates.Add($path) }
    }

    $pythonCommands = Get-Command python.exe -All -ErrorAction SilentlyContinue
    foreach ($command in $pythonCommands) {
        $path = $command.Source
        if ($path -and $path -notmatch '\\WindowsApps\\') { $candidates.Add($path) }
    }

    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) {
        try {
            & $launcher.Source -3.11 -c 'import sys; print(sys.executable)' 2>$null | ForEach-Object { $candidates.Add($_) }
        } catch { }
    }

    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        try {
            & $candidate -c 'import fastapi, uvicorn, sqlalchemy, asyncpg, redis' 2>$null
            if ($LASTEXITCODE -eq 0) { return $candidate }
            if ($InstallDependencies) {
                Write-Host "Installing backend dependencies with $candidate..." -ForegroundColor Yellow
                & $candidate -m pip install -r (Join-Path $repoRoot 'requirements.txt')
                if ($LASTEXITCODE -eq 0) {
                    & $candidate -c 'import fastapi, uvicorn, sqlalchemy, asyncpg, redis' 2>$null
                    if ($LASTEXITCODE -eq 0) { return $candidate }
                }
                throw 'Backend dependency installation failed.'
            }
            Write-Host "Python was found at $candidate, but required backend packages are missing." -ForegroundColor Yellow
            Write-Host "Run .\run_dev.ps1 -InstallDependencies to install requirements.txt." -ForegroundColor Yellow
            return $null
        } catch {
            Write-Host "Could not use Python runtime $candidate`: $($_.Exception.Message)" -ForegroundColor DarkYellow
        }
    }
    return $null
}

Write-Host 'Starting AirGuard local services...' -ForegroundColor Cyan
$pythonExe = Resolve-PythonRuntime
if (-not $pythonExe) {
    throw 'No usable Python runtime with backend dependencies was found. Install Python 3.11, then run .\run_dev.ps1 -InstallDependencies.'
}

if (-not (Test-HttpEndpoint 'http://127.0.0.1:8001/health')) {
    Write-Host 'Applying database migrations...' -ForegroundColor Cyan
    Push-Location $backendDir
    try {
        & $pythonExe -m alembic upgrade head
        if ($LASTEXITCODE -ne 0) { throw 'Database migrations failed. Check the DATABASE_URL and PostgreSQL service.' }
    } finally {
        Pop-Location
    }

    Write-Host 'Starting FastAPI...' -ForegroundColor Cyan
    $null = Start-Process -FilePath $pythonExe `
        -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8001') `
        -WorkingDirectory $backendDir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $apiLog -RedirectStandardError $apiErrorLog

    $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    while ((Get-Date) -lt $deadline -and -not (Test-HttpEndpoint 'http://127.0.0.1:8001/health')) {
        Start-Sleep -Milliseconds 700
    }
    if (-not (Test-HttpEndpoint 'http://127.0.0.1:8001/health')) {
        Write-Host "API startup log: $apiLog" -ForegroundColor Red
        if (Test-Path $apiErrorLog) { Get-Content $apiErrorLog -Tail 40 }
        throw 'The API did not become healthy. Check PostgreSQL, Redis availability, and the API logs.'
    }
}

if (-not (Test-HttpEndpoint 'http://localhost:5173')) {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npm) { throw 'Node.js/npm is required to start the frontend.' }
    Write-Host 'Starting Vite frontend...' -ForegroundColor Cyan
    $null = Start-Process -FilePath $npm.Source `
        -ArgumentList @('run', 'dev', '--', '--host', 'localhost', '--port', '5173') `
        -WorkingDirectory $frontendDir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $webLog -RedirectStandardError $webErrorLog
}

Write-Host 'AirGuard is ready:' -ForegroundColor Green
Write-Host '  Frontend: http://localhost:5173'
Write-Host '  API docs: http://127.0.0.1:8001/docs'
Write-Host "  API log:  $apiLog"
