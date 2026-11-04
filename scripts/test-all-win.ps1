param([switch]$Replay, [switch]$ReleaseChecks)
$ErrorActionPreference = 'Stop'

# A non-inheritable Job handle owned by this PowerShell process closes if the
# console or runner is terminated. Windows then stops only its descendants.
Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class LibetarioTestJob {
    [StructLayout(LayoutKind.Sequential)] struct Basic {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO {
        public ulong Reads, Writes, Other, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct Extended {
        public Basic Limits;
        public IO Counters;
        public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
    }
    [DllImport("kernel32", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended info, int size);
    [DllImport("kernel32", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32")] static extern IntPtr GetCurrentProcess();
    public static void OwnDescendants() {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        var info = new Extended();
        info.Limits.Flags = 0x2000;
        if (!SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(info)) ||
            !AssignProcessToJobObject(job, GetCurrentProcess())) throw new Win32Exception();
    }
}
'@
[LibetarioTestJob]::OwnDescendants()
$arguments = @('--import', 'tsx', 'scripts/test-all.ts')
if ($Replay) { $arguments += '--replay' }
if ($ReleaseChecks) { $arguments += '--release-checks' }
& node @arguments
exit $LASTEXITCODE
