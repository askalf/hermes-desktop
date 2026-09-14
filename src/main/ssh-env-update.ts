/** One remote transaction shared by every Desktop SSH credential writer. */
export type RemoteEnvUpdate =
  | { operation: "set"; key: string; value: string }
  | { operation: "ensure-dashboard" }
  | { operation: "ensure-api" };

export interface RemoteEnvUpdateResult {
  values: Record<string, string>;
  changed: boolean;
}

// Input and selected results use JSON on stdin/stdout; credentials never enter
// the remote command line. Uses only Python's standard library on POSIX hosts.
export const REMOTE_ENV_UPDATE_SCRIPT = String.raw`
import fcntl
import json
import os
import re
import secrets
import stat
import sys
import tempfile
import time


def update_env(payload):
    path = os.path.realpath(os.path.expanduser(payload["path"]))
    operation = payload["operation"]
    if operation == "set":
        key, value = payload["key"], payload["value"]
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise ValueError("Invalid environment variable name")
        if not isinstance(value, str) or any(c in value for c in "\r\n\0"):
            raise ValueError("Environment value contains illegal characters")
    elif operation not in ("ensure-dashboard", "ensure-api"):
        raise ValueError("Unknown environment update")

    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    # The stable sibling lock is never renamed or unlinked. Locking .env itself
    # would lock an obsolete inode after the first atomic replacement.
    lock_fd = os.open(path + ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "a") as lock:
        deadline = time.monotonic() + 10
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("Timed out waiting for remote .env lock")
                time.sleep(0.05)

        previous = None
        try:
            with open(path, "r", encoding="utf-8", errors="surrogateescape", newline="") as source:
                previous = os.fstat(source.fileno())
                if not stat.S_ISREG(previous.st_mode):
                    raise ValueError("Remote .env is not a regular file")
                content = source.read()
        except FileNotFoundError:
            # A genuinely absent file is valid for first-time provisioning.
            # Permission, decoding, and other read failures must never seed it.
            content = ""

        lines = content.splitlines(keepends=True)
        newline = "\r\n" if "\r\n" in content else "\n"
        values = {}
        for line in lines:
            match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)", line)
            if match:
                raw = match[2].strip()
                if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
                    raw = raw[1:-1]
                values[match[1]] = raw

        if operation == "set":
            updates = {key: value}
        elif operation == "ensure-dashboard":
            key = "HERMES_DASHBOARD_SESSION_TOKEN"
            updates = {key: values.get(key, "").strip() or secrets.token_hex(24)}
        else:
            key = values.get("API_SERVER_KEY", "").strip()
            placeholder = r"(?:changeme|placeholder|your[-_]?(?:api[-_]?)?key|api[-_]?server[-_]?key|secret|password|token)"
            if len(key) < 16 or re.fullmatch(placeholder, key, re.I):
                key = secrets.token_hex(24)
            enabled = values.get("API_SERVER_ENABLED", "").strip().lower()
            updates = {"API_SERVER_KEY": key, "API_SERVER_ENABLED": enabled if enabled in ("true", "1", "yes") else "true"}

        output = []
        seen = set()
        for line in lines:
            match = re.match(r"^\s*(?:#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
            key = match[1] if match else None
            if key not in updates:
                output.append(line)
            elif key not in seen:
                ending = "\r\n" if line.endswith("\r\n") else "\n" if line.endswith("\n") else ""
                output.append(key + "=" + updates[key] + ending)
                seen.add(key)
        for key, value in updates.items():
            if key not in seen:
                if output and not output[-1].endswith(("\n", "\r")):
                    output[-1] += newline
                output.append(key + "=" + value + newline)
        updated = "".join(output)
        changed = updated != content
        if changed:
            fd, temporary = tempfile.mkstemp(prefix=".env-", suffix=".tmp", dir=directory)
            try:
                with os.fdopen(fd, "w", encoding="utf-8", errors="surrogateescape", newline="") as target:
                    if previous is not None:
                        current = os.fstat(target.fileno())
                        if (current.st_uid, current.st_gid) != (previous.st_uid, previous.st_gid):
                            os.fchown(target.fileno(), previous.st_uid, previous.st_gid)
                        os.fchmod(target.fileno(), stat.S_IMODE(previous.st_mode))
                    target.write(updated)
                    target.flush()
                    os.fsync(target.fileno())
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        return {"values": updates, "changed": changed}


try:
    print(json.dumps(update_env(json.load(sys.stdin))))
except Exception as error:
    print("Could not safely update remote credentials: " + str(error), file=sys.stderr)
    sys.exit(1)
`;
