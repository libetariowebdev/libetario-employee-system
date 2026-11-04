"""Extract only the release backup format into a newly created staging directory."""

import os
import re
import sys
import tarfile
from pathlib import Path, PurePosixPath


AREAS = {"objects", "quarantine", "payslip-objects", "payslip-quarantine"}
OUTER = {"manifest.json", "database.dump", "private.tar"}


def clean(name):
    while name.startswith("./"):
        name = name[2:]
    if name == ".":
        return ()
    parts = PurePosixPath(name).parts
    if "\\" in name or ":" in name or name.startswith("/") or ".." in parts:
        raise ValueError("Unsafe archive path")
    return parts


def main():
    mode, source, directory = sys.argv[1:]
    if mode not in ("bundle", "private"):
        raise ValueError("Invalid backup archive type")
    target = Path(directory).resolve(strict=True)
    if any(target.iterdir()):
        raise ValueError("Archive destination must be empty")
    names = set()
    with tarfile.open(source, mode="r:") as archive:
        for entry in archive:
            parts = clean(entry.name)
            if parts in names:
                raise ValueError("Duplicate backup archive path")
            if mode == "bundle":
                if len(parts) != 1 or parts[0] not in OUTER or not entry.isfile():
                    raise ValueError("Unexpected backup member")
            elif len(parts) <= 1:
                if not entry.isdir() or (parts and parts[0] not in AREAS):
                    raise ValueError("Unexpected private storage directory")
            else:
                if len(parts) != 2 or parts[0] not in AREAS or not re.fullmatch(r"[0-9a-f]{64}\.bin", parts[1]):
                    raise ValueError("Unexpected private file path")
                if entry.islnk():
                    counterpart = clean(entry.linkname)
                    pairs = ({"objects", "quarantine"}, {"payslip-objects", "payslip-quarantine"})
                    if len(counterpart) != 2 or counterpart not in names or counterpart[1] != parts[1] or {counterpart[0], parts[0]} not in pairs:
                        raise ValueError("Unsafe or unrecognized backup hard link")
                    target.joinpath(parts[0]).mkdir(exist_ok=True)
                    # The standard extractor may fall back to copying a link's bytes.
                    # Cleanup requires the original paired inode, so fail if linking fails.
                    os.link(target.joinpath(*counterpart), target.joinpath(*parts))
                    names.add(parts)
                    continue
                elif not entry.isfile():
                    raise ValueError("Unsafe private file type")
            archive.extract(entry, target, filter="data", set_attrs=False)
            names.add(parts)
    if mode == "bundle" and names != {(name,) for name in OUTER}:
        raise ValueError("Incomplete backup archive")
    if mode == "private":
        for entry in target.rglob("*"):
            entry.chmod(0o700 if entry.is_dir() else 0o400)


if __name__ == "__main__":
    main()
