#!/usr/bin/env python3
"""
Rewrite relative imports in web test files to @/ aliases, then move the
files into __tests__/unit/ or __tests__/integration/ subdirectories.

Order matters: rewrite first so the alias form (depth-independent) is in
place before the file moves. Otherwise the intermediate state has broken
relative imports.

Classification rule: a test file is "integration" if it imports from
'react', '@testing-library/*', or 'vitest-dom'; otherwise it is "unit".
"""

from __future__ import annotations

import os
import re
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WEB_ROOT = REPO_ROOT / "web"
SRC_ROOT = WEB_ROOT / "src"

# Match `import ... from '../something'` and `import ... from './something'`
# Also handles `import type { ... } from '...'`
IMPORT_RE = re.compile(
    r"""^(?P<prefix>import\s+(?:type\s+)?)"""
    r"""(?P<body>[^'"]*?)"""
    r"""\s+from\s+['"](?P<path>\.\.?/[^'"]+)['"]""",
    re.MULTILINE,
)

# Also match bare side-effect imports: `import '../something'`
SIDE_EFFECT_RE = re.compile(
    r"""^(import\s+)['"](?P<path>\.\.?/[^'"]+)['"]""",
    re.MULTILINE,
)

# Match relative string arguments to function calls: vi.mock('../foo', ...),
# vi.hoisted('../foo', ...), jest.mock('../foo', ...), require('../foo'),
# and dynamic import('../foo').
# Captures the function context + the relative path.
CALL_ARG_RE = re.compile(
    r"""(?P<prefix>(?:vi|jest)\.(?:mock|hoisted|unmock)\s*\(\s*|require\s*\(\s*|import\s*\(\s*)"""
    r"""['"](?P<path>\.\.?/[^'"]+)['"]""",
)


def resolve_import(file_path: Path, rel_path: str) -> str | None:
    """Resolve a relative import path to a src-relative path (no leading @/).

    Returns None if the resolved path escapes src/ (should not happen for
    well-formed test imports).
    """
    file_dir = file_path.parent
    resolved = (file_dir / rel_path).resolve()
    try:
        src_rel = resolved.relative_to(SRC_ROOT.resolve())
    except ValueError:
        return None
    # Strip any trailing .ts/.tsx extension that might be in the import
    return str(src_rel)


def original_dir(file_path: Path) -> Path:
    """Compute the original directory of a test file before it was moved.

    Test files were moved from src/foo/__tests__/bar.test.ts to
    src/foo/__tests__/{unit,integration}/bar.test.ts. This reverses that.
    """
    parent = file_path.parent
    if parent.name in ("unit", "integration") and parent.parent.name == "__tests__":
        return parent.parent
    return parent


def resolve_import_original(file_path: Path, rel_path: str) -> str | None:
    """Resolve a relative path as if the file were at its original location.

    For files that have already been moved into __tests__/unit/ or
    __tests__/integration/, this resolves from the __tests__/ directory.
    """
    orig_dir = original_dir(file_path)
    resolved = (orig_dir / rel_path).resolve()
    try:
        src_rel = resolved.relative_to(SRC_ROOT.resolve())
    except ValueError:
        return None
    return str(src_rel)


def rewrite_file(file_path: Path) -> tuple[int, list[str]]:
    """Rewrite all relative imports in a single file.

    Returns (count_of_rewrites, list_of_warnings).
    """
    original = file_path.read_text(encoding="utf-8")
    warnings: list[str] = []
    count = 0

    def replace_named(m: re.Match) -> str:
        nonlocal count
        rel = m.group("path")
        src_rel = resolve_import(file_path, rel)
        if src_rel is None:
            warnings.append(f"  ESCAPES src: {file_path}:{rel}")
            return m.group(0)
        count += 1
        return f"{m.group('prefix')}{m.group('body')} from '@/{src_rel}'"

    def replace_side_effect(m: re.Match) -> str:
        nonlocal count
        rel = m.group("path")
        src_rel = resolve_import(file_path, rel)
        if src_rel is None:
            warnings.append(f"  ESCAPES src: {file_path}:{rel}")
            return m.group(0)
        count += 1
        return f"{m.group(1)}'@/{src_rel}'"

    new_text = IMPORT_RE.sub(replace_named, original)
    new_text = SIDE_EFFECT_RE.sub(replace_side_effect, new_text)

    # vi.mock / require / dynamic import with relative paths. These were
    # correct at the file's original location before it was moved into
    # __tests__/unit/ or __tests__/integration/, so resolve from there.
    def replace_call_arg(m: re.Match) -> str:
        nonlocal count
        rel = m.group("path")
        src_rel = resolve_import_original(file_path, rel)
        if src_rel is None:
            warnings.append(f"  ESCAPES src (call arg): {file_path}:{rel}")
            return m.group(0)
        count += 1
        return f"{m.group('prefix')} '@/{src_rel}'"

    new_text = CALL_ARG_RE.sub(replace_call_arg, new_text)

    if new_text != original:
        file_path.write_text(new_text, encoding="utf-8")

    return count, warnings


def classify_file(file_path: Path) -> str:
    """Classify a test file as 'unit' or 'integration' based on imports."""
    text = file_path.read_text(encoding="utf-8")
    # Any React / testing-library / vitest-dom usage → integration
    if re.search(r"""from\s+['"](?:react|react-dom|@testing-library/[^'"]+|vitest-dom)['"]""", text):
        return "integration"
    return "unit"


def find_test_files() -> list[Path]:
    """Find all .test.ts/.test.tsx files under src/."""
    result = []
    for root, _dirs, files in os.walk(SRC_ROOT):
        for name in files:
            if name.endswith(".test.ts") or name.endswith(".test.tsx"):
                result.append(Path(root) / name)
    result.sort()
    return result


def main() -> int:
    if "--check" in sys.argv:
        mode = "check"
    elif "--apply" in sys.argv:
        mode = "apply"
    else:
        print("Usage: rewrite-test-imports.py [--check|--apply]", file=sys.stderr)
        return 2

    test_files = find_test_files()
    total_rewrites = 0
    all_warnings: list[str] = []
    classification: dict[Path, str] = {}

    # Step 1: classify + rewrite imports in place
    for f in test_files:
        cls = classify_file(f)
        classification[f] = cls
        if mode == "apply":
            n, warns = rewrite_file(f)
            total_rewrites += n
            all_warnings.extend(warns)

    if mode == "check":
        # Just count what would change
        for f in test_files:
            text = f.read_text(encoding="utf-8")
            for m in IMPORT_RE.finditer(text):
                total_rewrites += 1
            for m in SIDE_EFFECT_RE.finditer(text):
                total_rewrites += 1
            for m in CALL_ARG_RE.finditer(text):
                total_rewrites += 1

    # Step 2: compute move plan
    moves: list[tuple[Path, Path]] = []
    for f in test_files:
        cls = classification[f]
        # f is e.g. src/foo/__tests__/bar.test.ts
        # target: src/foo/__tests__/{unit,integration}/bar.test.ts
        parent = f.parent  # e.g. src/foo/__tests__
        # Handle already-moved files (idempotency)
        if parent.name in ("unit", "integration"):
            continue
        target_dir = parent / cls
        target = target_dir / f.name
        moves.append((f, target))

    if mode == "check":
        print(f"would rewrite {total_rewrites} import(s) across {len(test_files)} file(s)")
        print(f"would move {len(moves)} file(s):")
        unit_count = sum(1 for _, t in moves if "/unit/" in str(t))
        int_count = sum(1 for _, t in moves if "/integration/" in str(t))
        print(f"  unit:        {unit_count}")
        print(f"  integration: {int_count}")
        if all_warnings:
            print("WARNINGS:")
            for w in all_warnings:
                print(w)
        return 0

    # mode == "apply"
    print(f"rewrote {total_rewrites} import(s) across {len(test_files)} file(s)")

    # Execute moves
    moved = 0
    for src, dst in moves:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
        moved += 1

    print(f"moved {moved} file(s)")

    # Clean up empty __tests__ dirs (only ones that had all files moved out)
    for f in test_files:
        parent = f.parent
        if parent.exists() and parent.name == "__tests__" and not any(parent.iterdir()):
            parent.rmdir()

    if all_warnings:
        print("WARNINGS:")
        for w in all_warnings:
            print(w)

    return 0


if __name__ == "__main__":
    sys.exit(main())
