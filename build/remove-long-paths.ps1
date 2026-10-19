# Invoked by the NSIS uninstaller before it stages or deletes the install directory.
# NSIS file operations (FindFirst, CreateDirectory, Rename, Delete, RMDir) stop at
# MAX_PATH, but the 7-Zip extraction that installed the app does not: the bundled Pi
# agent's nested node_modules under resources installs fine yet can never be moved or
# deleted by NSIS. un.atomicRMDir also stages every file under $PLUGINSDIR\old-install,
# usually a longer base than the install directory, so the longer base decides. Only
# the entries NSIS cannot handle are deleted, through \\?\ paths; nothing outside
# <install directory>\resources is touched and reparse points are never followed.
param(
    [Parameter(Mandatory = $true)][string]$InstallDirectory,
    [Parameter(Mandatory = $true)][string]$StagingDirectory,
    [Parameter(Mandatory = $true)][string]$LogPath,
    # Four-character margins under Rename/Delete's 260 and CreateDirectory's 248.
    [int]$FileLimit = 256,
    [int]$DirectoryLimit = 244
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Diagnostic([string]$Message) {
    $line = 'TTRemoveLongPaths: ' + $Message
    [Console]::Out.WriteLine($line)
    # A locked log must not turn a completed removal into a failure.
    try { Add-Content -LiteralPath $LogPath -Value $line -Encoding Unicode } catch { }
}

# Win32 file APIs skip MAX_PATH parsing for \\?\ paths; UNC shares use \\?\UNC\.
function ConvertTo-ExtendedPath([string]$Path) {
    if ($Path.StartsWith('\\?\')) { return $Path }
    if ($Path.StartsWith('\\')) { return '\\?\UNC\' + $Path.Substring(2) }
    return '\\?\' + $Path
}

function Get-IoPath([string]$Path) {
    if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { return ConvertTo-ExtendedPath $Path }
    return $Path
}

function Remove-TTEntry([string]$Path, [bool]$Directory) {
    $io = Get-IoPath $Path
    try {
        Remove-Item -LiteralPath $io -Force
    } catch {
        # Some PowerShell hosts reject \\?\ provider paths; the .NET calls accept them.
        if ($Directory) {
            [IO.Directory]::Delete($io, $false)
        } else {
            [IO.File]::SetAttributes($io, [IO.FileAttributes]::Normal)
            [IO.File]::Delete($io)
        }
    }
    if ($Directory) { $present = [IO.Directory]::Exists($io) } else { $present = [IO.File]::Exists($io) }
    if ($present) { throw 'still present after removal' }
}

function Invoke-TTRemoveLongPaths {
  param([string]$InstallDirectory, [string]$StagingDirectory, [string]$LogPath,
        [int]$FileLimit = 256, [int]$DirectoryLimit = 244)
  try {
    $directory = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
    if ($directory -eq [IO.Path]::GetPathRoot($directory).TrimEnd('\')) {
        throw 'Refusing a drive root as the application directory.'
    }
    $root = [IO.Path]::Combine($directory, 'resources')
    if (-not [IO.Directory]::Exists($root)) {
        Write-Diagnostic "no resources directory under $directory"
        return 0
    }
    # NSIS builds "$INSTDIR$R0\$R2" and "$PLUGINSDIR\old-install$R0\$R2": lengths are
    # the longer base plus the characters below it, counted from the raw NSIS strings
    # so 8.3 names and the \\?\ prefix cannot skew them.
    $base = [Math]::Max($directory.Length, $StagingDirectory.TrimEnd('\').Length)
    $files = [System.Collections.Generic.List[object]]::new()
    $folders = [System.Collections.Generic.List[object]]::new()
    $pending = [System.Collections.Generic.Queue[object]]::new()
    $pending.Enqueue([pscustomobject]@{ Path = $root; Relative = 1 + 'resources'.Length })
    $scanned = 0
    while ($pending.Count) {
        $current = $pending.Dequeue()
        foreach ($entry in [IO.DirectoryInfo]::new((Get-IoPath $current.Path)).GetFileSystemInfos()) {
            $scanned++
            $relative = $current.Relative + 1 + $entry.Name.Length
            $item = [pscustomobject]@{ Path = [IO.Path]::Combine($current.Path, $entry.Name); Length = $base + $relative }
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                Write-Diagnostic "skipped link length=$($item.Length) path=$($item.Path)"
            } elseif ($entry -is [IO.DirectoryInfo]) {
                $pending.Enqueue([pscustomobject]@{ Path = $item.Path; Relative = $relative })
                if ($item.Length -ge $DirectoryLimit) { $folders.Add($item) }
            } elseif ($item.Length -ge $FileLimit) {
                $files.Add($item)
            }
        }
    }
    Write-Diagnostic "scanned=$scanned base=$base fileLimit=$FileLimit directoryLimit=$DirectoryLimit files=$($files.Count) directories=$($folders.Count)"

    $failed = 0
    foreach ($item in $files) {
        try {
            Remove-TTEntry $item.Path $false
            Write-Diagnostic "removed length=$($item.Length) file=$($item.Path)"
        } catch {
            $failed++
            Write-Diagnostic "failed length=$($item.Length) file=$($item.Path) $($_.Exception.Message)"
        }
    }
    # A blocking directory's children are longer still, so they went above; delete the
    # deepest first, never recursively, and only once empty.
    foreach ($item in @($folders | Sort-Object -Property Length -Descending)) {
        try {
            if ([IO.DirectoryInfo]::new((Get-IoPath $item.Path)).GetFileSystemInfos().Count) {
                throw 'directory is not empty'
            }
            Remove-TTEntry $item.Path $true
            Write-Diagnostic "removed length=$($item.Length) directory=$($item.Path)"
        } catch {
            $failed++
            Write-Diagnostic "failed length=$($item.Length) directory=$($item.Path) $($_.Exception.Message)"
        }
    }
    Write-Diagnostic "failed=$failed"
    if ($failed) { return 20 }
    return 0
  } catch {
    Write-Diagnostic "scan failed: $($_.Exception.Message)"
    return 20
  }
}

# Dot-sourcing loads the functions for isolated tests.
if ($MyInvocation.InvocationName -ne '.') {
    exit (Invoke-TTRemoveLongPaths @PSBoundParameters)
}
