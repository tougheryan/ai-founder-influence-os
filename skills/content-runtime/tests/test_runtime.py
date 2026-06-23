#!/usr/bin/env python3
"""content-runtime 轻量测试套件"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from content_runtime import ContentRuntime
from session_manager import SessionManager


def run() -> int:
    fails = 0
    with tempfile.TemporaryDirectory() as tmp:
        project = Path(tmp)
        rt = ContentRuntime(project)
        rt.init()

        # 1. validate valid intake
        valid = project / "intake_valid.md"
        valid.write_text((Path(__file__).parent / "fixtures" / "intake_valid.md").read_text(encoding="utf-8"), encoding="utf-8")
        res = rt.validate("intake", str(valid))
        if res["valid"]:
            print("PASS validate valid intake")
        else:
            print("FAIL validate valid intake", res)
            fails += 1

        # 2. validate invalid intake
        invalid = project / "intake_invalid.md"
        invalid.write_text((Path(__file__).parent / "fixtures" / "intake_invalid.md").read_text(encoding="utf-8"), encoding="utf-8")
        res = rt.validate("intake", str(invalid))
        if not res["valid"] and res.get("missing_patterns"):
            print("PASS validate invalid intake")
        else:
            print("FAIL validate invalid intake", res)
            fails += 1

        # 3. write + read roundtrip
        rt.write("intake", "roundtrip", "## 0. 素材场景\n测试。\n\n## 1. 人物\n测试。\n\n## 3. 观点\n测试。\n\n## 6. 商业意图\n测试。", source="test")
        data = rt.read("intake", latest=True)
        if data["frontmatter"].get("slug") == "roundtrip" and "素材场景" in data["body"]:
            print("PASS write/read roundtrip")
        else:
            print("FAIL write/read roundtrip", data)
            fails += 1

        # 4. validate valid audit
        audit = project / "audit_valid.md"
        audit.write_text((Path(__file__).parent / "fixtures" / "audit_valid.md").read_text(encoding="utf-8"), encoding="utf-8")
        res = rt.validate("audit", str(audit))
        if res["valid"]:
            print("PASS validate valid audit")
        else:
            print("FAIL validate valid audit", res)
            fails += 1

        # 5. session manager route
        sm = SessionManager(project)
        route = sm.route("帮我写获客口播")
        if route["skill"] == "douyin-script":
            print("PASS session route to douyin-script")
        else:
            print("FAIL session route", route)
            fails += 1

        # 6. boot returns dashboard
        boot = sm.boot(force=True)
        if "内容作战台" in boot["dashboard"]:
            print("PASS session boot dashboard")
        else:
            print("FAIL session boot dashboard")
            fails += 1

    print(f"\n{'PASS' if fails == 0 else 'FAIL'}: {fails} failure(s)")
    return fails


if __name__ == "__main__":
    raise SystemExit(run())
