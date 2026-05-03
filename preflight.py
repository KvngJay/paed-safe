#!/usr/bin/env python3
"""
PaedSafe — preflight.py
Run before every push to main.
Reads PAEDSAFE_CONFIG.version from data.js and compares to manifest.json.
Exits with code 1 (blocking push) if they differ.

Usage:
  python3 preflight.py
  
Add to .git/hooks/pre-push to automate:
  #!/bin/sh
  python3 preflight.py || exit 1
"""

import re
import json
import sys

DATA_FILE     = "data.js"
MANIFEST_FILE = "manifest.json"

# Extract version from data.js — looks for: version: "1.0.0"
with open(DATA_FILE, "r") as f:
    content = f.read()

match = re.search(r'version:\s*["\']([^"\']+)["\']', content)
if not match:
    print(f"❌ PREFLIGHT FAILED: Could not find version in {DATA_FILE}")
    sys.exit(1)

data_version = match.group(1)

# Extract version from manifest.json
with open(MANIFEST_FILE, "r") as f:
    manifest = json.load(f)

manifest_version = manifest.get("version", "NOT FOUND")

# Compare
if data_version != manifest_version:
    print(f"❌ PREFLIGHT FAILED: Version mismatch!")
    print(f"   {DATA_FILE}:      {data_version}")
    print(f"   {MANIFEST_FILE}: {manifest_version}")
    print(f"   Update manifest.json version to '{data_version}' before pushing.")
    sys.exit(1)

print(f"✅ PREFLIGHT PASSED: Version {data_version} consistent across data.js and manifest.json")
sys.exit(0)