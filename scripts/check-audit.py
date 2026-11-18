"""Fail when npm audit reports a high or critical package outside the allowlist."""
import json
import sys


def names(path):
    data = json.loads(open(path).read() or "{}")
    found = set()
    for package, info in (data.get("vulnerabilities") or {}).items():
        if info.get("severity") in ("high", "critical"):
            found.add(package)
    return found


def allowed(path):
    rows = []
    for line in open(path):
        line = line.split("#", 1)[0].strip()
        if line:
            rows.append(line)
    return set(rows)


def main():
    report, allow_path = sys.argv[1:]
    found = names(report)
    accepted = allowed(allow_path)
    new = sorted(found - accepted)
    stale = sorted(accepted - found)
    if stale:
        print("allowlist entries that are no longer high or critical:")
        for name in stale:
            print(f"  {name}")
    if new:
        print("new high or critical advisories:")
        for name in new:
            print(f"  {name}")
        print("Patch the package or add it to scripts/audit-allowlist.txt with a reason.")
        return 1
    print(f"no new high or critical advisories ({len(found)} accepted)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
