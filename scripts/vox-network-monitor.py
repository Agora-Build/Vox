#!/usr/bin/env python3
"""Unprivileged host sampler for container agents; no credentials or network calls.

Run as the agent owner with an explicit --output directory. Bind-mount that
directory read-only and set VOX_NETWORK_STATUS_FILE inside the container.
Only hashed local topology and coarse link types are written; never IPs/SSIDs.
"""
import argparse
import collections
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import time
import uuid


def command(*args):
    return subprocess.check_output(args, timeout=0.5, stderr=subprocess.DEVNULL, text=True)


def match(pattern, text):
    found = re.search(pattern, text, re.M)
    return found.group(1) if found else ""


def observe():
    if platform.system() == "Linux":
        route = command("ip", "route", "get", "1.1.1.1")
        iface = match(r"\bdev\s+(\S+)", route)
        if not re.fullmatch(r"[A-Za-z0-9._@:-]{1,32}", iface) or iface in (".", ".."):
            raise ValueError("No interface")
        nic = Path("/sys/class/net") / iface
        driver = (nic / "device/driver").resolve().name
        link = "wifi" if (nic / "wireless").exists() else "cellular" if iface.startswith("wwan") or driver in ("qmi_wwan", "cdc_mbim", "cdc_ether") else "ethernet"
        if not (nic / "device").exists() and link == "ethernet":
            raise ValueError("Virtual interface")
        fingerprint = "|".join((iface, match(r"\bvia\s+(\S+)", route), match(r"\bsrc\s+(\S+)", route)))
        addresses = command("ip", "-o", "addr", "show", "dev", iface)
        if link == "wifi":
            try:
                fingerprint += match(r"Connected to (\S+)", command("iw", "dev", iface, "link"))
            except (OSError, subprocess.SubprocessError):
                pass
    elif platform.system() == "Darwin":
        route = command("route", "-n", "get", "default")
        iface = match(r"^\s*interface:\s*(\S+)", route)
        if not re.fullmatch(r"[A-Za-z0-9._@:-]{1,32}", iface):
            raise ValueError("No interface")
        ports = command("networksetup", "-listallhardwareports")
        port = next((block for block in re.split(r"\n\s*\n", ports) if match(r"^Device:\s*(\S+)", block) == iface), "")
        if not port:
            raise ValueError("Unknown hardware")
        link = "wifi" if "Hardware Port: Wi-Fi" in port else "ethernet"
        fingerprint = "|".join((iface, match(r"^\s*gateway:\s*(\S+)", route), match(r"inet\s+(\S+)", command("ifconfig", iface))))
        addresses = command("ifconfig", iface)
    else:
        raise ValueError("Unsupported platform")
    ipv4 = re.findall(r"\binet\s+(\d+\.\d+\.\d+\.\d+)", addresses)
    public = any(ipaddress.ip_address(address).is_global for address in ipv4) if ipv4 else None
    return link, hashlib.sha256(fingerprint.encode()).hexdigest(), public


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, help="Private directory, e.g. /var/lib/vox-network")
    args = parser.parse_args()
    directory = Path(args.output).resolve()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    monitor = str(uuid.uuid4())
    events = collections.deque(maxlen=128)
    seq = gaps = 0
    previous = None
    last_sample = time.monotonic()
    available = False
    public = None
    while True:
        started = time.monotonic()
        timestamp = int(time.time() * 1000)
        if started - last_sample > 5:
            gaps += 1
        last_sample = started
        try:
            link, fingerprint, public = observe()
            if (link, fingerprint) != previous:
                seq += 1
                events.append({"seq": seq, "timestamp": timestamp, "link": link, "fingerprint": fingerprint})
                previous = (link, fingerprint)
            available = True
        except (OSError, ValueError, subprocess.SubprocessError):
            if available:
                gaps += 1
            available = False
        while events and events[0]["timestamp"] < timestamp - 120000 and len(events) > 1:
            events.popleft()
        status = {"version": 1, "monitor": monitor, "timestamp": timestamp, "seq": seq,
                  "gapCount": gaps, "available": available, "events": list(events),
                  "publicIpOnInterface": public,
                  "link": previous[0] if previous else None, "fingerprint": previous[1] if previous else None}
        temporary = directory / "status.tmp"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(status, stream)
        os.replace(temporary, directory / "status.json")
        time.sleep(max(0.05, 1 - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
