"""Own the disposable Linux process group and remove its scratch after exit."""

import ctypes
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def main():
    if sys.platform != "linux" or os.getuid() == 0:
        raise SystemExit("Run as an unprivileged Linux user")
    if sys.argv[1:] not in ([], ["--replay"], ["--release-checks"]):
        raise SystemExit("Usage: pnpm test:all:linux [--replay | --release-checks]")
    # Linux subreaper. If Next or the runner dies first, reap the orphaned workers here.
    if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
        raise SystemExit("Cannot supervise disposable Linux workers")
    parent = Path("/tmp").resolve(strict=True)
    scratch = Path(tempfile.mkdtemp(prefix="libetario-test-", dir=parent))
    identity = scratch.stat()
    worker = None
    interrupted = None
    env = {
        "PATH": os.environ["PATH"],
        "LIBETARIO_TEST_SCRATCH": str(scratch),
        "HOME": str(scratch),
        "LANG": "C.UTF-8",
    }

    def group_signal(sig):
        if worker:
            try:
                os.killpg(worker.pid, sig)
            except ProcessLookupError:
                pass

    def interrupt(sig, _frame):
        nonlocal interrupted
        if interrupted is None:
            interrupted = time.monotonic()
            group_signal(signal.SIGTERM)

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupt)

    try:
        if interrupted is not None:
            return 130
        worker = subprocess.Popen(
            ["node", "--import", "tsx", "scripts/test-all.ts", *sys.argv[1:]],
            env=env,
            start_new_session=True,
        )
        if interrupted is not None:
            group_signal(signal.SIGTERM)
        while worker.poll() is None:
            if interrupted is not None and time.monotonic() - interrupted > 8:
                group_signal(signal.SIGKILL)
            time.sleep(0.1)
        return 130 if interrupted is not None else (worker.returncode or 0)
    finally:
        if worker:
            group_signal(signal.SIGTERM)
            # Reap orphans after Popen has already reaped the group leader.
            def gone_within(seconds):
                end = time.monotonic() + seconds
                while time.monotonic() < end:
                    try:
                        while os.waitpid(-1, os.WNOHANG)[0]:
                            pass
                    except ChildProcessError:
                        pass
                    try:
                        os.killpg(worker.pid, 0)
                    except ProcessLookupError:
                        return True
                    time.sleep(0.1)
                return False

            if not gone_within(8):
                group_signal(signal.SIGKILL)
                if not gone_within(8):
                    raise RuntimeError("A disposable process remains. Scratch was retained for inspection")
        current = scratch.lstat()
        if (
            scratch.parent != parent
            or scratch.resolve(strict=True) != scratch
            or not scratch.name.startswith("libetario-test-")
            or (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino)
        ):
            raise RuntimeError("Unexpected scratch identity, cleanup refused")
        shutil.rmtree(scratch)


if __name__ == "__main__":
    sys.exit(main())
