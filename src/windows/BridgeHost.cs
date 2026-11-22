// Dedicated console host. Its job contains only this bridge worker and descendants.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
class BridgeHost {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;}
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
        public uint Size; public string Reserved, Desktop, Title; public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
        public ushort ShowWindow, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {public IntPtr Process, Thread; public uint ProcessId, ThreadId;}
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits limits, int size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processSecurity,
        IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static volatile bool cancelled;
    static string Quote(string value) {
        StringBuilder output=new StringBuilder("\""); int slashes=0;
        foreach(char c in value) {
            if(c=='\\') {slashes++;continue;}
            output.Append('\\',c=='"'?slashes*2+1:slashes);slashes=0;output.Append(c);
        }
        output.Append('\\',slashes*2);output.Append('"');return output.ToString();
    }
    static int Main(string[] args) {
        if(args.Length<2)return 2;
        IntPtr job=IntPtr.Zero;ProcessInfo child=new ProcessInfo();bool assigned=false;
        Console.CancelKeyPress+=(sender,e)=>{e.Cancel=true;cancelled=true;};
        try {
            job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Win32Exception();
            ExtendedLimits limits=new ExtendedLimits();limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE
            if(!SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(ExtendedLimits))))throw new Win32Exception();
            StringBuilder command=new StringBuilder();foreach(string arg in args){if(command.Length>0)command.Append(' ');command.Append(Quote(arg));}
            StartupInfo startup=new StartupInfo();startup.Size=(uint)Marshal.SizeOf(typeof(StartupInfo));
            // Suspend before assignment: no worker or child runs outside the job.
            if(!CreateProcess(args[0],command,IntPtr.Zero,IntPtr.Zero,false,4,IntPtr.Zero,null,ref startup,out child))throw new Win32Exception();
            if(!AssignProcessToJobObject(job,child.Process))throw new Win32Exception();assigned=true;
            if(ResumeThread(child.Thread)==0xffffffff)throw new Win32Exception();
            CloseHandle(child.Thread);child.Thread=IntPtr.Zero;
            while(WaitForSingleObject(child.Process,100)==258){if(cancelled){WaitForSingleObject(child.Process,5000);return 0;}}
            uint code;return GetExitCodeProcess(child.Process,out code)?(int)code:2;
        } catch {Console.Error.WriteLine("Bridge host could not start or contain the worker.");return 2;}
        finally {
            if(!assigned&&child.Process!=IntPtr.Zero)TerminateProcess(child.Process,2);
            if(child.Thread!=IntPtr.Zero)CloseHandle(child.Thread);
            if(job!=IntPtr.Zero)CloseHandle(job);
            if(child.Process!=IntPtr.Zero)CloseHandle(child.Process);
        }
    }
}
