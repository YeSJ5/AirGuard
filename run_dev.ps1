param(
    [switch]$InstallDependencies,
    [int]$StartupTimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot
$backendDir = Join-Path $repoRoot 'backend'
$frontendDir = Join-Path $repoRoot 'frontend'
$apiLog = Join-Path $env:TEMP 'airguard-api.log'
$apiErrorLog = Join-Path $env:TEMP 'airguard-api-error.log'
$webLog = Join-Path $env:TEMP 'airguard-web.log'
$webErrorLog = Join-Path $env:TEMP 'airguard-web-error.log'
$redisLog = Join-Path $env:TEMP 'airguard-redis.log'
$redisErrorLog = Join-Path $env:TEMP 'airguard-redis-error.log'

function Get-ApiHealth {
    $client = $null
    $response = $null
    try {
        Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
        $client = [System.Net.Http.HttpClient]::new()
        $client.Timeout = [TimeSpan]::FromSeconds(3)
        $response = $client.GetAsync('http://127.0.0.1:8001/health').GetAwaiter().GetResult()
        # HttpClient returns the response for 503 as well as 200, so we can
        # distinguish a degraded AirGuard API from an API that is not running.
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $payload = $body | ConvertFrom-Json -ErrorAction Stop
        if ($payload.service -ne 'AirGuard') { return $null }
        return [pscustomobject]@{
            StatusCode = [int]$response.StatusCode
            Database = [string]$payload.database
            Redis = [string]$payload.redis
        }
    } catch {
        return $null
    } finally {
        if ($response) { $response.Dispose() }
        if ($client) { $client.Dispose() }
    }
}

function Test-TcpPort([int]$Port) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $attempt = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $attempt.AsyncWaitHandle.WaitOne(500)) { return $false }
        $client.EndConnect($attempt)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
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

if (-not (Test-TcpPort -Port 6379)) {
    $memuraiExe = Join-Path $repoRoot '.local\memurai\memurai.exe'
    if (Test-Path -LiteralPath $memuraiExe) {
        $redisDataDir = Join-Path $repoRoot '.local\redis-data'
        New-Item -ItemType Directory -Force -Path $redisDataDir | Out-Null
        Write-Host 'Starting local Redis-compatible service...' -ForegroundColor Cyan
        $redisProcess = Start-Process -FilePath $memuraiExe `
            -ArgumentList @('--port', '6379', '--bind', '127.0.0.1', '--protected-mode', 'yes', '--dir', $redisDataDir, '--appendonly', 'yes') `
            -WorkingDirectory $redisDataDir -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $redisLog -RedirectStandardError $redisErrorLog

        $redisDeadline = (Get-Date).AddSeconds(15)
        while ((Get-Date) -lt $redisDeadline -and -not (Test-TcpPort -Port 6379)) {
            if ($redisProcess.HasExited) { break }
            Start-Sleep -Milliseconds 300
        }
        if (-not (Test-TcpPort -Port 6379)) {
            if (Test-Path $redisErrorLog) { Get-Content $redisErrorLog -Tail 25 }
            throw 'The local Redis-compatible service did not start on port 6379.'
        }
    } else {
        Write-Host 'Redis is not running and no local Memurai runtime is staged; the API will be degraded.' -ForegroundColor Yellow
    }
}

$apiHealth = Get-ApiHealth
$apiListening = Test-TcpPort -Port 8001
if (-not $apiListening) {
    Write-Host 'Applying database migrations...' -ForegroundColor Cyan
    Push-Location $backendDir
    try {
        & $pythonExe -m alembic upgrade head
        if ($LASTEXITCODE -ne 0) { throw 'Database migrations failed. Check the DATABASE_URL and PostgreSQL service.' }
    } finally {
        Pop-Location
    }

    # Another AirGuard launcher may have brought the API up while migrations
    # were running. Recheck the port immediately before binding to avoid 10048.
    if (-not (Test-TcpPort -Port 8001)) {
        Write-Host 'Starting FastAPI...' -ForegroundColor Cyan
        $apiProcess = Start-Process -FilePath $pythonExe `
            -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8001') `
            -WorkingDirectory $backendDir -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $apiLog -RedirectStandardError $apiErrorLog
    } else {
        Write-Host 'API became available during migrations; reusing it.' -ForegroundColor Cyan
    }

    $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    while ((Get-Date) -lt $deadline -and -not (Test-TcpPort -Port 8001)) {
        if ($apiProcess -and $apiProcess.HasExited) { break }
        Start-Sleep -Milliseconds 700
    }
    if (-not (Test-TcpPort -Port 8001)) {
        Write-Host "API startup log: $apiLog" -ForegroundColor Red
        if (Test-Path $apiErrorLog) { Get-Content $apiErrorLog -Tail 40 }
        throw 'The API did not start listening on port 8001. Check PostgreSQL and the API logs.'
    }
}
elseif (-not $apiHealth -or $apiHealth.Database -ne 'connected') {
    throw 'Port 8001 is already in use, but a healthy AirGuard API could not be confirmed. Check the service on that port before retrying.'
}

$apiHealth = Get-ApiHealth
if ($apiHealth.Redis -ne 'connected') {
    Write-Host 'API and PostgreSQL are ready; Redis is unavailable, so live streaming is degraded.' -ForegroundColor Yellow
}

if (-not (Test-TcpPort -Port 5173)) {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npm) { throw 'Node.js/npm is required to start the frontend.' }
    Write-Host 'Starting Vite frontend...' -ForegroundColor Cyan
    $null = Start-Process -FilePath $npm.Source `
        -ArgumentList @('run', 'dev', '--', '--host', 'localhost', '--port', '5173') `
        -WorkingDirectory $frontendDir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $webLog -RedirectStandardError $webErrorLog
    $webDeadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $webDeadline -and -not (Test-TcpPort -Port 5173)) {
        Start-Sleep -Milliseconds 300
    }
    if (-not (Test-TcpPort -Port 5173)) {
        if (Test-Path $webErrorLog) { Get-Content $webErrorLog -Tail 30 }
        throw 'The frontend did not start listening on port 5173.'
    }
} else {
    Write-Host 'Frontend port 5173 is already in use; reusing it.' -ForegroundColor Cyan
}

Write-Host 'AirGuard is ready:' -ForegroundColor Green
Write-Host '  Frontend: http://localhost:5173'
Write-Host '  API docs: http://127.0.0.1:8001/docs'
Write-Host "  API log:  $apiLog"
