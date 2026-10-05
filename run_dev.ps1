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
$workerLog = Join-Path $env:TEMP 'airguard-worker.log'
$workerErrorLog = Join-Path $env:TEMP 'airguard-worker-error.log'

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
    # localhost may resolve to IPv6 first (as Vite does on some Windows
    # setups). Check both loopback families so a healthy ::1 listener is reused.
    foreach ($address in @('127.0.0.1', '::1')) {
        $client = [System.Net.Sockets.TcpClient]::new()
        try {
            $attempt = $client.BeginConnect($address, $Port, $null, $null)
            if (-not $attempt.AsyncWaitHandle.WaitOne(500)) { continue }
            $client.EndConnect($attempt)
            return $true
        } catch {
            continue
        } finally {
            $client.Dispose()
        }
    }
    return $false
}

function Test-AirGuardFrontend {
    foreach ($url in @('http://127.0.0.1:5173/', 'http://localhost:5173/')) {
        $client = $null
        $response = $null
        try {
            Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
            $client = [System.Net.Http.HttpClient]::new()
            $client.Timeout = [TimeSpan]::FromSeconds(2)
            $response = $client.GetAsync($url).GetAwaiter().GetResult()
            if (-not $response.IsSuccessStatusCode) { continue }
            $html = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            if ($html -match '(?i)<title>\s*AirGuard' -or $html -match '/@vite/client') {
                return $true
            }
        } catch {
            continue
        } finally {
            if ($response) { $response.Dispose() }
            if ($client) { $client.Dispose() }
        }
    }
    return $false
}

function Resolve-PythonRuntime {
    $primaryVenv = Join-Path $repoRoot '.venv\Scripts\python.exe'
    if (Test-Path -LiteralPath $primaryVenv) {
        try {
            & $primaryVenv -c 'import fastapi, uvicorn, sqlalchemy, asyncpg, redis' 2>$null
            if ($LASTEXITCODE -eq 0) { return $primaryVenv }
        } catch { }
    }

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
            -ArgumentList @('-u', '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8001') `
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

# Local development needs the same Redis Stream consumer used by Docker. Without
# it the API can ingest and enqueue telemetry while no aircraft are persisted.
$workerRunning = $false
$workerReady = $false
if ($apiHealth.Redis -eq 'connected') {
    Push-Location $backendDir
    try {
        & $pythonExe -m app.worker --check-active *> $null
        $workerRunning = ($LASTEXITCODE -eq 0)
        $workerReady = $workerRunning
    } finally {
        Pop-Location
    }
}

if (-not $workerRunning -and $apiHealth.Redis -eq 'connected') {
    Write-Host 'Starting Redis detection worker...' -ForegroundColor Cyan
    Push-Location $backendDir
    try {
        $workerProcess = Start-Process -FilePath $pythonExe `
            -ArgumentList @('-u', '-m', 'app.worker') `
            -WorkingDirectory $backendDir -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $workerLog -RedirectStandardError $workerErrorLog
    } finally {
        Pop-Location
    }

    $workerDeadline = (Get-Date).AddSeconds(60)
    $workerReady = $false
    while ((Get-Date) -lt $workerDeadline) {
        Push-Location $backendDir
        try {
            & $pythonExe -m app.worker --check-active *> $null
            $workerReady = ($LASTEXITCODE -eq 0)
        } finally {
            Pop-Location
        }
        if ($workerReady) {
            break
        }
        Start-Sleep -Milliseconds 1000
    }
    if (-not $workerReady) {
        Write-Host "Detection worker log: $workerLog" -ForegroundColor Red
        if (Test-Path $workerErrorLog) { Get-Content $workerErrorLog -Tail 30 }
        throw 'The Redis detection worker did not become ready. Check its logs and Redis/PostgreSQL services.'
    }
} else {
    if ($workerRunning) {
        Write-Host 'Redis detection worker is already running; reusing it.' -ForegroundColor Cyan
    } else {
        Write-Host 'Redis is unavailable; live telemetry worker is not started.' -ForegroundColor Yellow
    }
}

if (-not (Test-TcpPort -Port 5173)) {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if (-not $npm) { throw 'Node.js/npm is required to start the frontend.' }
    Write-Host 'Starting Vite frontend...' -ForegroundColor Cyan
    $null = Start-Process -FilePath $npm.Source `
        -ArgumentList @('run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173', '--strictPort') `
        -WorkingDirectory $frontendDir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $webLog -RedirectStandardError $webErrorLog
    $webDeadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $webDeadline -and -not (Test-AirGuardFrontend)) {
        Start-Sleep -Milliseconds 300
    }
    if (-not (Test-AirGuardFrontend)) {
        if (Test-Path $webErrorLog) { Get-Content $webErrorLog -Tail 30 }
        if (Test-Path $webLog) { Get-Content $webLog -Tail 30 }
        throw 'Vite did not serve the AirGuard application on port 5173. Check the frontend logs and confirm port 5173 is free.'
    }
} else {
    if (-not (Test-AirGuardFrontend)) {
        throw 'Port 5173 is occupied by a page that is not the AirGuard Vite app. Close the conflicting process, then rerun this launcher.'
    }
    Write-Host 'AirGuard frontend is already healthy on port 5173; reusing it.' -ForegroundColor Cyan
}

if ($apiHealth.Redis -eq 'connected' -and $workerReady) {
    Write-Host 'AirGuard is ready with live ingestion and detection:' -ForegroundColor Green
} else {
    Write-Host 'AirGuard web and API are available; live ingestion/detection is DEGRADED:' -ForegroundColor Yellow
}
Write-Host '  Frontend: http://localhost:5173'
Write-Host '  API docs: http://127.0.0.1:8001/docs'
Write-Host "  API log:  $apiLog"
