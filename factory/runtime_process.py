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

_PROC_ROOT = Path('/proc')


def _stat_state_group(body: str) -> tuple[str, int]:
    # The comm field may contain spaces and closing parentheses.
    prefix, fields = body.rsplit(')', 1)
    pid, separator, _ = prefix.partition(' (')
    values = fields.split()
    if (not separator or not pid.isdigit() or len(values) < 3
            or len(values[0]) != 1 or not values[0].isascii() or not values[0].isalpha()
            or int(values[1]) < 0 or int(values[2]) < 0):
        raise ValueError('invalid process state')
    return values[0], int(values[2])


def _linux_group_states(pgid: int) -> list[str]:
    states = []
    for process in _PROC_ROOT.iterdir():
        if not process.name.isdigit():
            continue
        try:
            state, group = _stat_state_group((process / 'stat').read_text())
            if group != pgid:
                continue
            states.append(state)
            if state != 'Z':
                continue
            # A zombie thread-group leader can still have live sibling threads.
            try:
                tasks = list((process / 'task').iterdir())
            except (FileNotFoundError, ProcessLookupError):
                if (process / 'stat').exists():
                    raise RuntimeError('cannot verify process group membership')
                continue
            if not tasks:
                raise RuntimeError('cannot verify process group membership')
            for task in tasks:
                try:
                    task_state, task_group = _stat_state_group((task / 'stat').read_text())
                except (FileNotFoundError, ProcessLookupError):
                    continue
                if task_group == pgid:
                    states.append(task_state)
        except (FileNotFoundError, ProcessLookupError):
            # A disappearing process no longer executes; other read failures
            # remain unknown rather than being interpreted as successful cleanup.
            continue
    return states


def group_has_live_members(pgid: int) -> bool:
    """Observe a POSIX group; unknown membership raises instead of proving cleanup.

    Zombies cannot execute or keep listeners open but still make killpg(..., 0)
    succeed. This helper never sends a mutating signal, including after PID reuse.
    """
    if type(pgid) is not int or pgid <= 0:
        raise ValueError('process group must be a positive integer')
    try:
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            pass
        if sys.platform == 'linux':
            states = _linux_group_states(pgid)
        else:
            result = subprocess.run(['/bin/ps', '-axo', 'pgid=,stat='],
                capture_output=True, text=True, check=True, timeout=5)
            states = []
            for row in result.stdout.splitlines():
                columns = row.split()
                if (len(columns) != 2 or not columns[0].isdigit()
                        or not columns[1][0].isascii() or not columns[1][0].isalpha()):
                    raise ValueError('invalid process state')
                if int(columns[0]) == pgid:
                    states.append(columns[1][0])
        if states:
            return any(state != 'Z' for state in states)
        # A process may exit during the scan. Missing rows alone are insufficient.
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return False
        raise RuntimeError('cannot verify process group membership')
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        raise RuntimeError('cannot verify process group membership') from None


class ProcessTree:
    def __init__(self, argv, cwd, env):
        if os.name != "nt" and (not callable(getattr(os, "waitid", None))
                                or not hasattr(os, "WNOWAIT")):
            raise RuntimeError("owned runtime cleanup requires POSIX waitid/WNOWAIT support "
                               "(on macOS, Python 3.13 or later)")
        self.job = None
        self.closed = False
        self._reaped_by_cleanup = False
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
        if self._reaped_by_cleanup:
            return self.proc.returncode
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
        failure = None
        try:
            self._close_owned()
        except BaseException as error:
            failure = error
            raise
        finally:
            if self.proc.stdin and not self.proc.stdin.closed:
                try:
                    self.proc.stdin.close()
                except BaseException as cleanup_error:
                    if failure is None:
                        raise
                    failure.add_note(f'Runtime stdin cleanup failed: {cleanup_error}')

    def _close_owned(self):
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
        elif os.name != "nt" and not self._reaped_by_cleanup:
            self.poll()  # Refuse numeric group signals if another caller reaped it.
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except PermissionError:
                # macOS can return EPERM for an exited, unreaped leader alone.
                # Only later live-membership checks can prove cleanup completed.
                if self.poll() is None:
                    raise
        elif os.name == "nt" and self.proc.poll() is None:
            self.proc.kill()
        if not self._reaped_by_cleanup:
            self.proc.wait(timeout=15)
            self._reaped_by_cleanup = True
        if os.name != "nt":
            deadline = time.monotonic() + 15
            while group_has_live_members(self.proc.pid):
                if time.monotonic() >= deadline:
                    raise TimeoutError("owned runtime process group did not exit; cleanup is unverified")
                time.sleep(.02)
        self.closed = True


if __name__ == "__main__":
    # No shell; stdin is private and never a workflow result or an agent prompt.
    data = json.loads(sys.stdin.buffer.readline())
    child = subprocess.Popen(data["argv"], cwd=data["cwd"], env=data["env"], close_fds=True)
    raise SystemExit(child.wait())
