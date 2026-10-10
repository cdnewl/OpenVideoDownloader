#!/usr/bin/env python3
"""Mimic Chrome's locale validation: every $VAR$ in a message text must be
declared in that message's placeholders (or be a $1..$9 substitution index)."""

import glob
import json
import re
import sys

VAR_RE = re.compile(r"\$([A-Za-z0-9__]+)\$")

failed = False
for path in glob.glob("_locales/*/messages.json"):
    data = json.load(open(path, encoding="utf-8"))
    for key, entry in data.items():
        text = entry.get("message", "")
        declared = set((entry.get("placeholders") or {}).keys())
        for m in VAR_RE.finditer(text):
            name = m.group(1)
            if name.isdigit():
                continue  # $1..$9 positional substitutions are allowed
            if name not in declared:
                print(f"FAIL {path}: [{key}] uses ${name}$ without placeholder")
                failed = True
    print(f"ok   {path}: {len(data)} messages checked")

sys.exit(1 if failed else 0)
