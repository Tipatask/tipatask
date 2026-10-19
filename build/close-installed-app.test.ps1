# Isolated provider tests, compatible with Windows PowerShell 5.1 and PowerShell 7.
# No real processes are queried or killed, and no external test module is needed.
$ErrorActionPreference = 'Stop'
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('tt-installer-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $scratch | Out-Null
$log = Join-Path $scratch 'diagnostics.log'
. "$PSScriptRoot/close-installed-app.ps1" -InstallDirectory $scratch -InstallerProcessId 4000 -LogPath $log

function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Entry([int]$Id, [string]$Image, [int]$Parent = 0, [string]$Name = 'TipATask.exe') {
    [pscustomobject]@{ ProcessId = $Id; ExecutablePath = $Image; ParentProcessId = $Parent;
                     Name = $Name; CreationDate = [datetime]'2020-01-01' }
}
function Reset-Fixture($Rows) {
    $script:rows = @($Rows)
    $script:kills = @()
    $script:queryFails = $false
    $script:stubborn = $false
    $script:reuse = $false
}
function Get-CimInstance {
    [CmdletBinding()]param([string]$ClassName, [string]$Filter)
    if ($script:queryFails) { throw 'fixture: CIM unavailable' }
    if ($Filter) {
        $target = [int]($Filter -replace 'ProcessId=', '')
        if ($script:reuse) {
            $script:rows = @($script:rows | Where-Object { $_.ProcessId -ne $target })
            $script:rows += Entry $target 'C:\unrelated\node.exe' 0 'node.exe'
        }
        return $script:rows | Where-Object { $_.ProcessId -eq $target }
    }
    return $script:rows
}
function Invoke-AppTaskkill([int]$ProcessId, [bool]$IncludeChildren) {
    $script:kills += [pscustomobject]@{ Id = $ProcessId; Tree = $IncludeChildren }
    if ($script:stubborn) { return @{ ExitCode = 5; Output = 'fixture: access denied' } }
    $removed = @($ProcessId)
    if ($IncludeChildren) {
        do {
            $previous = $removed.Count
            $removed += @($script:rows | Where-Object {
                $removed -contains $_.ParentProcessId -and $removed -notcontains $_.ProcessId
            } | ForEach-Object { $_.ProcessId })
        } while ($removed.Count -gt $previous)
    }
    $script:rows = @($script:rows | Where-Object { $removed -notcontains $_.ProcessId })
    return @{ ExitCode = 0; Output = 'fixture: closed' }
}
function Start-Sleep { param([int]$Milliseconds) }
function Run([string]$Mode = 'Check') {
    Invoke-TTCloseInstalledApp -InstallDirectory $directory -InstallerProcessId 4000 -LogPath $log -Mode $Mode
}

try {
    $directory = Join-Path $scratch "O'Brien App"
    $prefix = $directory + '\'
    Reset-Fixture @()
    Assert ((Run) -eq 0) 'Closed app must succeed.'

    Reset-Fixture @((Entry 4000 ($prefix + 'setup.exe') 0 'setup.exe'),
                    (Entry $PID ($prefix + 'powershell.exe') 4000 'powershell.exe'),
                    (Entry 20 ($prefix + 'TipATask.exe')))
    Assert ((Run) -eq 10) 'Running app must be reported separately from errors.'
    Assert ($script:kills.Count -eq 0) 'Check must not kill anything.'

    Reset-Fixture @((Entry 20 ($prefix.ToUpperInvariant() + 'TipATask.exe')),
                    (Entry 21 'C:\unrelated\TipATask.exe'),
                    (Entry 22 ($directory + '-other\TipATask.exe')),
                    (Entry 23 'C:\external\node.exe' 20 'node.exe'))
    Assert ((Run 'Close') -eq 0) 'Close must handle case, spaces and apostrophes.'
    Assert ($script:kills.Count -eq 1 -and $script:kills[0].Id -eq 20 -and $script:kills[0].Tree) 'Kill only the verified application tree.'
    Assert (($script:rows | Where-Object { $_.ProcessId -in @(21,22) }).Count -eq 2) 'Unrelated same-name and sibling-directory processes must survive.'
    Assert (-not ($script:rows | Where-Object { $_.ProcessId -eq 23 })) 'Application descendants must close.'

    Reset-Fixture @((Entry 4000 ($prefix + 'setup.exe') 40 'setup.exe'),
                    (Entry 40 ($prefix + 'TipATask.exe')),
                    (Entry 41 ($prefix + 'resources\node.exe') 40 'node.exe'))
    Assert ((Run 'Close') -eq 0) 'An app that launched setup must close.'
    Assert (-not ($script:kills | Where-Object { $_.Id -eq 40 }).Tree) 'Do not tree-kill an ancestor of setup.'
    Assert (($script:rows | Where-Object { $_.ProcessId -eq 4000 }).Count -eq 1) 'Setup must survive.'

    Reset-Fixture @((Entry 20 ($prefix + 'TipATask.exe')))
    $script:stubborn = $true
    Assert ((Run 'Close') -eq 10) 'Surviving app must remain a failure.'
    Assert ($script:kills.Count -eq 5) 'Automatic retries must stop at five.'

    Reset-Fixture @()
    $script:queryFails = $true
    Assert ((Run) -eq 20) 'Query failure must not mean app closed.'

    Reset-Fixture @((Entry 20 '' 0 'TipATask.exe'))
    Assert ((Run) -eq 20) 'An inaccessible app image must not be silently ignored.'

    Reset-Fixture @((Entry 20 ($prefix + 'TipATask.exe')))
    $script:reuse = $true
    Assert ((Run 'Close') -eq 0) 'A process that exits during shutdown is harmless.'
    Assert ($script:kills.Count -eq 0) 'A reused PID with another image must not be killed.'

    # The uninstall-section check runs inside an uninstaller that may sit in the install
    # directory, launched by a setup that may sit there too.
    Reset-Fixture @((Entry 4000 ($prefix + 'Uninstall TipATask.exe') 4100 'Uninstall TipATask.exe'),
                    (Entry 4100 ($prefix + 'TipATask Setup.exe') 0 'TipATask Setup.exe'))
    Assert ((Run) -eq 0) 'The running uninstaller and its parent setup are not the app.'
    Assert ((Run 'Close') -eq 0 -and $script:kills.Count -eq 0) 'Close must spare the uninstaller and its parent setup.'

    Reset-Fixture @()
    $rootDirectory = [IO.Path]::GetPathRoot($directory)
    Assert ((Invoke-TTCloseInstalledApp -InstallDirectory $rootDirectory -InstallerProcessId 4000 -LogPath $log) -eq 20) 'A drive root must never be accepted as an app directory.'
    Assert ($script:kills.Count -eq 0) 'An invalid install directory must not select processes.'

    $contents = Get-Content -LiteralPath $log -Raw
    Assert ($contents.Contains('taskkillExit=5') -and $contents.Contains('CIM unavailable') -and $contents.Contains('remainingCount=0')) 'Log must distinguish kill, query and closed outcomes.'
    Write-Output 'PASS: 10 isolated installer process scenarios'
} finally {
    Remove-Item -LiteralPath $scratch -Recurse -Force
}
