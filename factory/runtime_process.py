"""Ordinary process ownership; never workflow or provider dispatch.

The worker waits for assignment before executing project code. Windows jobs contain
descendants even after the initial command exits. Unix commands must remain in the
owned session (daemonization is unsupported).
"""
from __future__ import annotations
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


class ProcessTree:
    def __init__(self, argv, cwd, env):
        if os.name != "nt" and (not callable(getattr(os, "waitid", None))
                                or not hasattr(os, "WNOWAIT")):
            raise RuntimeError("owned runtime cleanup requires POSIX waitid/WNOWAIT support "
                               "(on macOS, Python 3.13 or later)")
        self.job = None
        self.closed = False
        self.proc = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "worker"],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=os.name != "nt", close_fds=True)
        try:
            if os.name == "nt":
                import ctypes as c
                from ctypes import wintypes as w
                class Basic(c.Structure):
                    _fields_ = [("per_process", c.c_int64), ("per_job", c.c_int64),
                                ("flags", w.DWORD), ("min", c.c_size_t), ("max", c.c_size_t),
                                ("active", w.DWORD), ("affinity", c.c_size_t),
                                ("priority", w.DWORD), ("scheduling", w.DWORD)]
                class Extended(c.Structure):
                    _fields_ = [("basic", Basic), ("io", c.c_uint64 * 6),
                                ("process_memory", c.c_size_t), ("job_memory", c.c_size_t),
                                ("peak_process", c.c_size_t), ("peak_job", c.c_size_t)]
                self.kernel = c.WinDLL("kernel32", use_last_error=True)
                self.kernel.CreateJobObjectW.argtypes = [c.c_void_p, w.LPCWSTR]
                self.kernel.CreateJobObjectW.restype = w.HANDLE
                self.kernel.SetInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
                self.kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
                self.kernel.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
                self.kernel.QueryInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.c_void_p]
                self.kernel.CloseHandle.argtypes = [w.HANDLE]
                self.job = self.kernel.CreateJobObjectW(None, None)
                info = Extended()
                info.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                if (not self.job or not self.kernel.SetInformationJobObject(
                        self.job, 9, c.byref(info), c.sizeof(info)) or
                        not self.kernel.AssignProcessToJobObject(self.job, int(self.proc._handle))):
                    raise OSError("Windows job assignment failed")
            self.proc.stdin.write(json.dumps({"argv": argv, "cwd": str(cwd), "env": env}).encode() + b"\n")
            self.proc.stdin.close()
        except BaseException as failure:
            try:
                if os.name == "nt" and self.proc.poll() is None:
                    self.proc.kill()  # assignment may have failed before joining the job
                self.close()
            except BaseException as cleanup_error:
                failure.add_note(f"Runtime process cleanup failed: {cleanup_error}")
            raise

    def poll(self):
        """Observe exit without releasing the POSIX process-group identity."""
        if os.name == "nt" or self.closed:
            return self.proc.poll()
        if self.proc.returncode is not None:
            raise RuntimeError("runtime process owner was reaped; refusing unreserved group cleanup")
        try:
            state = os.waitid(os.P_PID, self.proc.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        except ChildProcessError:
            raise RuntimeError("runtime process owner was reaped outside its cleanup") from None
        if state is None:
            return None
        return state.si_status if state.si_code == os.CLD_EXITED else -state.si_status

    def close(self):
        if self.closed:
            return
        if self.job:
            import ctypes as c
            from ctypes import wintypes as w
            class Accounting(c.Structure):
                _fields_ = [("times", c.c_int64 * 4), ("faults", w.DWORD),
                            ("total", w.DWORD), ("active", w.DWORD), ("terminated", w.DWORD)]
            self.kernel.TerminateJobObject(self.job, 1)
            deadline = time.monotonic() + 15
            while True:
                info = Accounting()
                if not self.kernel.QueryInformationJobObject(self.job, 1, c.byref(info), c.sizeof(info), None):
                    raise OSError("cannot verify Windows job termination")
                if info.active == 0:
                    break
                if time.monotonic() >= deadline:
                    raise TimeoutError("Windows job descendants did not terminate")
                time.sleep(.02)
            self.kernel.CloseHandle(self.job)
            self.job = None
        elif os.name != "nt":
            self.poll()  # Refuse numeric group signals if another caller reaped it.
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except PermissionError:
                # macOS can return EPERM for an exited, unreaped leader alone.
                # Only a later absence check can prove cleanup completed.
                if self.poll() is None:
                    raise
        elif self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait(timeout=15)
        if os.name != "nt":
            deadline = time.monotonic() + 15
            while True:
                try:
                    os.killpg(self.proc.pid, 0)
                except ProcessLookupError:
                    break
                except PermissionError:
                    pass
                if time.monotonic() >= deadline:
                    raise TimeoutError("owned runtime process group did not exit; cleanup is unverified")
                time.sleep(.02)
        if self.proc.stdin and not self.proc.stdin.closed:
            self.proc.stdin.close()
        self.closed = True


if __name__ == "__main__":
    # No shell; stdin is private and never a workflow result or an agent prompt.
    data = json.loads(sys.stdin.buffer.readline())
    child = subprocess.Popen(data["argv"], cwd=data["cwd"], env=data["env"], close_fds=True)
    raise SystemExit(child.wait())
