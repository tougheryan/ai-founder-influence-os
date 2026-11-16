#!/usr/bin/env python3
"""Calibrate TikOmni v5 against at least 45 manually labelled samples."""
from __future__ import annotations

import argparse
import json
import tempfile
import os
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any

from market_signal import MarketSignal, _coerce_signal, score_market_signal_batch


PLATFORMS = ("wechat_mp", "xiaohongshu", "wechat_channels")


class CalibrationError(RuntimeError):
    pass


def _read(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CalibrationError(f"无法读取校准集：{path}") from exc
    if not isinstance(value, dict) or not isinstance(value.get("samples"), list):
        raise CalibrationError("校准集必须包含 samples 数组")
    return value


def _write(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def calibrate(dataset_path: Path, output_path: Path) -> dict[str, Any]:
    dataset = _read(dataset_path)
    captured_at = str(dataset.get("captured_at") or datetime.now().astimezone().isoformat())
    rows: list[tuple[MarketSignal, bool, str]] = []
    for item in dataset["samples"]:
        if not isinstance(item, dict) or not isinstance(item.get("human_verified_hit"), bool):
            raise CalibrationError("每条样本必须有 human_verified_hit 布尔标注")
        signal = _coerce_signal(item)
        if signal is None or signal.platform not in PLATFORMS:
            raise CalibrationError("校准样本平台或字段无效")
        rows.append((signal, item["human_verified_hit"], str(item.get("annotation_note") or "")))
    counts = {platform: sum(1 for signal, _, _ in rows if signal.platform == platform) for platform in PLATFORMS}
    if len(rows) < 45 or any(count < 15 for count in counts.values()):
        raise CalibrationError("校准集必须不少于 45 条，且每个平台至少 15 条")

    signals = [signal for signal, _, _ in rows]
    grouped: dict[tuple[str, str], list[MarketSignal]] = {}
    for signal in signals:
        grouped.setdefault((signal.platform, signal.query), []).append(signal)
    for group in grouped.values():
        score_market_signal_batch(group, captured_at)

    predicted = [index for index, signal in enumerate(signals) if signal.sample_class == "verified_hit"]
    true_positive = sum(1 for index in predicted if rows[index][1])
    false_positive = len(predicted) - true_positive
    precision = true_positive / len(predicted) if predicted else 0.0
    invalid_false_hits = sum(
        1 for signal in signals
        if signal.sample_class == "verified_hit" and (
            signal.evidence_status == "insufficient"
            or not any(isinstance(value, int) and value > 0 for value in signal.metrics.values())
            or (signal.age_days is not None and signal.age_days < -0.25)
        )
    )
    passed = invalid_false_hits == 0 and precision >= 0.90
    report = {
        "schema_version": "echo-founder.tikomni-calibration.v5",
        "score_version": "echo-founder.tikomni-hit-score.v5",
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "dataset_path": str(dataset_path),
        "sample_count": len(rows),
        "platform_counts": counts,
        "predicted_verified_hit_count": len(predicted),
        "true_positive": true_positive,
        "false_positive": false_positive,
        "verified_hit_precision": round(precision, 4),
        "invalid_evidence_false_hit_count": invalid_false_hits,
        "thresholds": {"minimum_precision": 0.90, "invalid_evidence_false_hits": 0},
        "passed": passed,
        "release_decision": "eligible" if passed else "downgrade_verified_hits_to_potential",
        "samples": [
            {**asdict(signal), "human_verified_hit": human_label, "annotation_note": note}
            for signal, human_label, note in rows
        ],
    }
    _write(output_path, report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = calibrate(args.dataset, args.output)
    print(json.dumps({key: value for key, value in report.items() if key != "samples"}, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 3


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CalibrationError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        raise SystemExit(2)
