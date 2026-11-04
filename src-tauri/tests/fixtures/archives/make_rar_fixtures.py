#!/usr/bin/env python3
"""Writes basic.rar and slip.rar (RAR5, stored entries) next to this script.

RARLAB's `rar` is not installable on macOS through Homebrew (cask disabled 2026-09-01,
Gatekeeper), and the rar CLI will not store a `../` name anyway, so these fixtures are
written byte-for-byte from the RAR5 format spec (https://www.rarlab.com/technote.htm).
Entries are stored (method 0), so no compressor is needed. Re-run to regenerate:
    python3 -I make_rar_fixtures.py
"""
from __future__ import annotations

import os
import struct
import zlib

SIG = b"Rar!\x1a\x07\x01\x00"
MTIME = 1_700_000_000  # fixed, so the bytes are reproducible


def vint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def header(body: bytes) -> bytes:
    # CRC32 covers the header-size field plus the header data that follows it
    sized = vint(len(body)) + body
    return struct.pack("<I", zlib.crc32(sized)) + sized


def main_header() -> bytes:
    return header(vint(1) + vint(0) + vint(0))  # type 1, header flags 0, archive flags 0


def end_header() -> bytes:
    return header(vint(5) + vint(0) + vint(0))  # type 5, header flags 0, end flags 0


def file_entry(name: str, data: bytes | None) -> bytes:
    is_dir = data is None
    data = data or b""
    name_b = name.encode("utf-8")
    file_flags = 0x0002 | (0x0001 if is_dir else 0x0004)  # mtime, dir or data CRC
    body = vint(2)  # header type: file
    body += vint(0x0002)  # header flags: data area present
    body += vint(len(data))  # data size
    body += vint(file_flags)
    body += vint(len(data))  # unpacked size
    body += vint(0o40755 if is_dir else 0o100644)  # unix attributes
    body += struct.pack("<I", MTIME)
    if not is_dir:
        body += struct.pack("<I", zlib.crc32(data))
    body += vint(0)  # compression info: RAR5 v0, stored, smallest dictionary
    body += vint(1)  # host OS: Unix
    body += vint(len(name_b)) + name_b
    return header(body) + data


def archive(entries) -> bytes:
    out = SIG + main_header()
    for name, data in entries:
        out += file_entry(name, data)
    return out + end_header()


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    basic = [
        ("hello.txt", b"hello from trove\n"),
        ("docs", None),
        ("docs/readme.md", b"# readme\n\nA RAR fixture.\n"),
        ("docs/notes.txt", b"one\ntwo\nthree\n"),
    ]
    slip = [
        ("good.txt", b"good\n"),
        ("../slip.txt", b"this must never land outside the target\n"),
    ]
    for fname, entries in (("basic.rar", basic), ("slip.rar", slip)):
        with open(os.path.join(here, fname), "wb") as f:
            f.write(archive(entries))


if __name__ == "__main__":
    main()
