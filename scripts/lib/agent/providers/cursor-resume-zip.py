#!/usr/bin/env python3
"""Bounded readback of an authenticated GitHub Actions Cursor D1 artifact ZIP.

The trusted workflow resolves the artifact ID and GitHub ZIP digest from an
independently authenticated main-owned Run. Never extract an unverified ZIP.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import zipfile

EXPECTED = frozenset(("ciphertext.json", "proof.json", "agent-telemetry.json"))
MAX_ZIP = 40 * 1024 * 1024
MAX_MEMBER = 32 * 1024 * 1024


def fail(message):
    raise ValueError("Cursor D1 source ZIP: " + message)


def unpack(archive, expected_digest, destination):
    if not expected_digest.startswith("sha256:") or len(expected_digest) != 71:
        fail("invalid attested SHA-256")
    file = Path(archive)
    if not file.is_file() or file.is_symlink() or file.stat().st_size > MAX_ZIP:
        fail("unavailable, unsafe or oversized archive")
    actual = hashlib.file_digest(file.open("rb"), "sha256").hexdigest()
    if actual != expected_digest[7:]:
        fail("artifact ZIP does not match authenticated GitHub SHA-256")
    dest = Path(destination)
    if dest.exists():
        fail("destination already exists")
    if not dest.parent.is_dir() or dest.parent.is_symlink():
        fail("unsafe destination parent")
    payload = {}
    with zipfile.ZipFile(file) as z:
        infos = z.infolist()
        if len(infos) != len(EXPECTED) or {i.filename for i in infos} != EXPECTED:
            fail("unexpected, duplicate or missing ZIP entry")
        total = 0
        for info in infos:
            mode = (info.external_attr >> 16) & 0o170000
            if mode not in (0, stat.S_IFREG) or info.is_dir():
                fail("nonregular ZIP member")
            if info.file_size <= 0 or info.file_size > MAX_MEMBER:
                fail("invalid member length")
            total += info.file_size
            if total > MAX_ZIP:
                fail("unbounded extracted ZIP")
            data = z.read(info, pwd=None)
            if len(data) != info.file_size:
                fail("ZIP length mismatch")
            try:
                value = json.loads(data)
            except (UnicodeDecodeError, json.JSONDecodeError):
                fail("invalid JSON member")
            if not isinstance(value, dict):
                fail("invalid member schema")
            payload[info.filename] = data
    dest.mkdir(mode=0o700)
    for name, data in payload.items():
        with (dest / name).open("xb") as stream:
            os.chmod(stream.fileno(), 0o600)
            stream.write(data)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit("usage: cursor-resume-zip.py ARCHIVE SHA256_HEX_FROM_API DESTINATION")
    try:
        unpack(sys.argv[1], sys.argv[2], sys.argv[3])
    except (ValueError, OSError, zipfile.BadZipFile) as error:
        sys.exit(str(error))
