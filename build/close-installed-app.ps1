# Invoked by NSIS in both setup and uninstall. Never fall back to image-name kills:
# another TipATask installation (or an unrelated node.exe) may be running.
param(
    [Parameter(Mandatory = $true)][string]$InstallDirectory,
    [Parameter(Mandatory = $true)][int]$InstallerProcessId,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [string]$AppExecutable = 'TipATask.exe',
    [ValidateSet('Check', 'Close')][string]$Mode = 'Check'
)

$ErrorActionPreference = 'Stop'

function Write-Diagnostic([string]$Message) {
    $line = 'TTCloseInstalledApp: ' + $Message
    [Console]::Out.WriteLine($line)
    Add-Content -LiteralPath $LogPath -Value $line -Encoding Unicode
}

function Invoke-AppTaskkill([int]$ProcessId, [bool]$IncludeChildren) {
    $killArguments = @('/F', '/PID', $ProcessId)
    if ($IncludeChildren) { $killArguments += '/T' }
    # Native stderr includes the normal race in which another tree-kill has already
    # removed this process; only the subsequent query decides whether it survived.
    $ErrorActionPreference = 'Continue'
    $output = & "$env:SystemRoot\System32\taskkill.exe" @killArguments 2>&1
    @{ ExitCode = $LASTEXITCODE; Output = ($output -join ' ') }
}

function Invoke-TTCloseInstalledApp {
  param([string]$InstallDirectory, [int]$InstallerProcessId, [string]$LogPath,
        [string]$AppExecutable = 'TipATask.exe', [string]$Mode = 'Check')
  try {
    $directory = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
    if ($directory -eq [IO.Path]::GetPathRoot($directory).TrimEnd('\')) {
        throw 'Refusing a drive root as the application directory.'
    }
    $prefix = $directory + '\'
    $snapshot = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    $excluded = @($PID, $InstallerProcessId)
    $ancestors = @($InstallerProcessId)
    # NSIS may have a bootstrap process with the same image. Protect it as well.
    # An app that launched setup must still close, without tree-killing setup itself.
    $ancestor = $InstallerProcessId
    while ($ancestor -and $ancestors.Count -lt 64) {
        $entry = $snapshot | Where-Object { $_.ProcessId -eq $ancestor } | Select-Object -First 1
        if (-not $entry -or $ancestors -contains [int]$entry.ParentProcessId) { break }
        $ancestor = [int]$entry.ParentProcessId
        $ancestors += $ancestor
        $parent = $snapshot | Where-Object { $_.ProcessId -eq $ancestor } | Select-Object -First 1
        if ($parent -and $parent.Name -ne $AppExecutable) {
            $excluded += $ancestor
        }
    }

    function Get-AppProcesses {
        $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
        if (@($processes | Where-Object { $_.Name -eq $AppExecutable -and -not $_.ExecutablePath }).Count) {
            throw "Cannot inspect the executable path of $AppExecutable. Close it manually or run with its permissions."
        }
        @($processes | Where-Object {
            $_.ExecutablePath -and $excluded -notcontains [int]$_.ProcessId -and
            $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
        })
    }

    Write-Diagnostic "mode=$Mode directory=$directory excludedPids=$($excluded -join ',')"
    $remaining = @(Get-AppProcesses)
    foreach ($process in $remaining) {
        Write-Diagnostic "matched pid=$($process.ProcessId) parent=$($process.ParentProcessId) image=$($process.ExecutablePath)"
    }
    if ($Mode -eq 'Close') {
        for ($attempt = 1; $attempt -le 5 -and $remaining.Count; $attempt++) {
            foreach ($process in $remaining) {
                # Revalidate before taskkill; a process may already have exited.
                $current = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$($process.ProcessId)" -ErrorAction Stop
                if (-not $current -or $current.CreationDate -ne $process.CreationDate -or
                    $current.ExecutablePath -ne $process.ExecutablePath) { continue }
                $kill = Invoke-AppTaskkill $process.ProcessId ($ancestors -notcontains [int]$process.ProcessId)
                Write-Diagnostic "attempt=$attempt pid=$($process.ProcessId) taskkillExit=$($kill.ExitCode) $($kill.Output)"
            }
            Start-Sleep -Milliseconds 500
            $remaining = @(Get-AppProcesses)
        }
    }
    foreach ($process in $remaining) {
        Write-Diagnostic "remaining pid=$($process.ProcessId) image=$($process.ExecutablePath)"
    }
    Write-Diagnostic "remainingCount=$($remaining.Count)"
    if ($remaining.Count) { return 10 }
    return 0
  } catch {
    # A failed query is not proof that the app has closed.
    Write-Diagnostic "query/close failed: $($_.Exception.Message)"
    return 20
  }
}

# Dot-sourcing loads the functions for isolated process-provider tests.
if ($MyInvocation.InvocationName -ne '.') {
    exit (Invoke-TTCloseInstalledApp @PSBoundParameters)
}
