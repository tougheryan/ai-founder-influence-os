#!/usr/bin/env python3
"""Paid image benchmark control plane for Echo Founder.

This module owns model freezing, credential readiness, the RMB budget ledger,
blind scoring and primary/backup selection. It never stores or prints keys and
does not use Codex login or a local image model as a paid-route substitute.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import math
import os
import re
import tempfile
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[3]
DEFAULT_REGISTRY = ROOT / "skills" / "content-runtime" / "config" / "image-provider-registry.json"
SCORE_WEIGHTS = {
    "aesthetics": 0.25,
    "platform_fit": 0.20,
    "consistency": 0.20,
    "prompt_adherence": 0.15,
    "semantic_match": 0.10,
    "latency": 0.05,
    "cost": 0.05,
}
HARD_FAILURES = {"unexpected_text", "unexpected_number", "logo", "watermark", "corrupt_file", "identity_drift"}


class BenchmarkError(RuntimeError):
    pass


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BenchmarkError(f"无法读取 JSON：{path}") from exc
    if not isinstance(value, dict):
        raise BenchmarkError(f"JSON 根节点必须是对象：{path}")
    return value


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
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


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


@contextmanager
def _ledger_lock(manifest_path: Path):
    lock_path = manifest_path.with_name(f".{manifest_path.name}.budget.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _sync_budget_unlocked(manifest_path: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    operations_dir = manifest_path.parent / f"{manifest['benchmark_id']}-operations"
    operations = [_read_json(path) for path in operations_dir.glob("*.json")] if operations_dir.exists() else []
    reserved = sum(float(item.get("charged_or_reserved_cny") or 0) for item in operations)
    actual_known = [item.get("actual_cost_cny") for item in operations if isinstance(item.get("actual_cost_cny"), (int, float))]
    actual = sum(float(value) for value in actual_known)
    manifest["budget_cny"] = {
        **(manifest.get("budget_cny") if isinstance(manifest.get("budget_cny"), dict) else {}),
        "reserved": round(reserved, 4),
        "actual": round(actual, 4),
        "actual_complete": len(actual_known) == len(operations),
    }
    manifest["updated_at"] = _now()
    _atomic_json(manifest_path, manifest)
    return manifest


def sync_manifest_budget(manifest_path: Path) -> dict[str, Any]:
    with _ledger_lock(manifest_path):
        return _sync_budget_unlocked(manifest_path, _read_json(manifest_path))


def credential_readiness(registry: dict[str, Any]) -> dict[str, Any]:
    groups = []
    for item in registry.get("credential_groups", []):
        env_name = str(item.get("env") or "")
        groups.append({
            "id": str(item.get("id") or ""),
            "configured": bool(env_name and os.environ.get(env_name)),
        })
    configured = sum(1 for item in groups if item["configured"])
    return {"configured": configured, "required": 6, "ready": configured == 6, "groups": groups}


def _openrouter_catalog(api_key: str) -> list[dict[str, Any]]:
    request = Request(
        "https://openrouter.ai/api/v1/images/models",
        headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
    )
    with urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    rows = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise BenchmarkError("OpenRouter 图像模型目录响应无效")
    return [item for item in rows if isinstance(item, dict)]


def _select_catalog_model(route: dict[str, Any], catalog: list[dict[str, Any]]) -> dict[str, Any]:
    discovery = route.get("model_discovery") if isinstance(route.get("model_discovery"), dict) else {}
    includes = [str(value).lower() for value in discovery.get("include", [])]
    prefers = [str(value).lower() for value in discovery.get("prefer", [])]
    excludes = [str(value).lower() for value in discovery.get("exclude", [])]
    matches = []
    for item in catalog:
        model_id = str(item.get("id") or "")
        haystack = f"{model_id} {item.get('name', '')}".lower()
        if includes and not all(token in haystack for token in includes):
            continue
        if any(token in haystack for token in excludes):
            continue
        created = item.get("created") if isinstance(item.get("created"), (int, float)) else 0
        preference = sum(1 for token in prefers if token in haystack)
        matches.append((preference, float(created), model_id, item))
    if not matches:
        raise BenchmarkError(f"官方目录没有找到正式模型：{route.get('id')}")
    return max(matches, key=lambda value: (value[0], value[1], value[2]))[3]


def _pins(values: list[str]) -> dict[str, tuple[str, str]]:
    result: dict[str, tuple[str, str]] = {}
    for value in values:
        parts = value.split("=", 2)
        if len(parts) != 3 or not all(part.strip() for part in parts):
            raise BenchmarkError("--pin 格式必须为 route_id=model_id=evidence_url")
        route_id, model_id, evidence_url = (part.strip() for part in parts)
        if not evidence_url.startswith("https://"):
            raise BenchmarkError("模型冻结证据必须是 HTTPS 官方目录链接")
        result[route_id] = (model_id, evidence_url)
    return result


def _estimates(values: list[str]) -> dict[str, float]:
    result: dict[str, float] = {}
    for value in values:
        route_id, separator, raw_amount = value.partition("=")
        try:
            amount = float(raw_amount)
        except ValueError as exc:
            raise BenchmarkError("--estimate 格式必须为 route_id=单次调用人民币上限") from exc
        if not separator or not route_id.strip() or not math.isfinite(amount) or amount <= 0 or amount > 40:
            raise BenchmarkError("--estimate 必须提供 0–40 元之间的单次付费调用上限")
        result[route_id.strip()] = round(amount, 4)
    return result


def init_manifest(
    registry_path: Path,
    output: Path,
    pin_values: list[str],
    estimate_values: list[str],
    usd_cny: float | None,
) -> dict[str, Any]:
    registry = _read_json(registry_path)
    if registry.get("schema_version") != "echo-founder.image-provider-registry.v1":
        raise BenchmarkError("生图路由注册表版本不受支持")
    routes = registry.get("routes") if isinstance(registry.get("routes"), list) else []
    if len(routes) != 10:
        raise BenchmarkError("真实付费 benchmark 必须恰好包含十条路由")
    readiness = credential_readiness(registry)
    supplied_pins = _pins(pin_values)
    supplied_estimates = _estimates(estimate_values)
    openrouter_routes = [route for route in routes if route.get("provider") == "openrouter"]
    catalog: list[dict[str, Any]] = []
    if openrouter_routes and os.environ.get("OPENROUTER_API_KEY"):
        catalog = _openrouter_catalog(os.environ["OPENROUTER_API_KEY"])

    frozen = []
    blockers = []
    for route in routes:
        route_id = str(route.get("id") or "")
        selected: dict[str, Any] | None = None
        evidence: dict[str, Any]
        if route.get("provider") == "openrouter" and catalog:
            selected = _select_catalog_model(route, catalog)
            model_id = str(selected.get("id") or "")
            evidence = {
                "kind": "official_api",
                "url": "https://openrouter.ai/api/v1/images/models",
                "catalog_item_sha256": hashlib.sha256(json.dumps(selected, sort_keys=True).encode()).hexdigest(),
            }
        elif route_id in supplied_pins:
            model_id, evidence_url = supplied_pins[route_id]
            lowered = model_id.lower()
            if any(token in lowered for token in ("preview", "beta", ":free")):
                raise BenchmarkError(f"禁止冻结预览、beta 或免费模型：{route_id}")
            evidence = {"kind": "official_directory_review", "url": evidence_url}
        else:
            model_id = ""
            evidence = {"kind": "missing"}
            blockers.append(f"{route_id}: 尚未从官方目录冻结正式模型 ID")
        estimated_cost_cny = supplied_estimates.get(route_id)
        if estimated_cost_cny is None:
            blockers.append(f"{route_id}: 尚未冻结单次调用人民币预算上限")
        frozen.append({
            "route_id": route_id,
            "provider": str(route.get("provider") or ""),
            "family": str(route.get("family") or ""),
            "model_id": model_id,
            "model_frozen_at": _now() if model_id else "",
            "discovery_evidence": evidence,
            "adapter": str(route.get("adapter") or ""),
            "pricing": selected.get("pricing") if selected else None,
            "estimated_cost_cny": estimated_cost_cny,
            "score": None,
            "hard_failures": [],
            "rank": None,
        })
    if not readiness["ready"]:
        blockers.append("六组真实付费账户密钥尚未全部配置")
    manifest = {
        "schema_version": "echo-founder.image-provider-benchmark.v1",
        "benchmark_id": f"imgbench_{datetime.now().strftime('%Y%m%d_%H%M%S')}",
        "status": "ready" if not blockers else "blocked",
        "created_at": _now(),
        "updated_at": _now(),
        "non_commercial": True,
        "registry_sha256": _sha256(registry_path),
        "exchange_rate": {"usd_cny": usd_cny, "source": "operator_verified_at_benchmark_start"} if usd_cny else None,
        "budget_cny": {**registry["budget_cny"], "reserved": 0.0, "actual": 0.0},
        "credential_readiness": readiness,
        "routes": frozen,
        "selection": {"top_three": [], "primary": None, "backup": None, "ai_enhanced_default_eligible": False},
        "blockers": blockers,
    }
    _atomic_json(output, manifest)
    return manifest


def reserve_operation(manifest_path: Path, route_id: str, phase: str, request_sha256: str, estimated_cost_cny: float) -> dict[str, Any]:
    with _ledger_lock(manifest_path):
        manifest = _read_json(manifest_path)
        if manifest.get("status") not in {"ready", "running", "scored", "accepted"}:
            raise BenchmarkError("benchmark 尚未满足十路由与六组账户就绪条件")
        if not re.fullmatch(r"[a-f0-9]{64}", request_sha256):
            raise BenchmarkError("请求摘要必须是 SHA-256")
        route_ids = {item.get("route_id") for item in manifest.get("routes", []) if isinstance(item, dict)}
        if route_id not in route_ids:
            raise BenchmarkError("route_id 不属于冻结 benchmark")
        caps = {"round_1": 40.0, "round_2": 25.0, "round_3": 30.0, "retry": 5.0}
        if phase not in caps or not math.isfinite(estimated_cost_cny) or estimated_cost_cny <= 0:
            raise BenchmarkError("付费调用阶段或预估费用无效")
        operations_dir = manifest_path.parent / f"{manifest['benchmark_id']}-operations"
        operation_id = hashlib.sha256(f"{manifest['benchmark_id']}\0{route_id}\0{phase}\0{request_sha256}".encode()).hexdigest()[:32]
        operation_path = operations_dir / f"{operation_id}.json"
        if operation_path.exists():
            return {**_read_json(operation_path), "operation_path": str(operation_path)}
        existing = [_read_json(path) for path in operations_dir.glob("*.json")] if operations_dir.exists() else []
        reserved_total = sum(float(item.get("charged_or_reserved_cny") or 0) for item in existing)
        phase_total = sum(float(item.get("charged_or_reserved_cny") or 0) for item in existing if item.get("phase") == phase)
        if reserved_total + estimated_cost_cny > 100.0 + 1e-9:
            raise BenchmarkError("人民币 100 元硬预算已达到，禁止发送新请求")
        if phase_total + estimated_cost_cny > caps[phase] + 1e-9:
            raise BenchmarkError(f"{phase} 阶段预算已达到，禁止发送新请求")
        operation = {
            "schema_version": "echo-founder.paid-image-operation.v1",
            "operation_id": operation_id,
            "benchmark_id": manifest["benchmark_id"],
            "route_id": route_id,
            "phase": phase,
            "request_sha256": request_sha256,
            "status": "prepared",
            "retry_allowed": False,
            "estimated_cost_cny": round(estimated_cost_cny, 4),
            "actual_cost_cny": None,
            "charged_or_reserved_cny": round(estimated_cost_cny, 4),
            "created_at": _now(),
            "updated_at": _now(),
        }
        _atomic_json(operation_path, operation)
        _sync_budget_unlocked(manifest_path, manifest)
        return {**operation, "operation_path": str(operation_path)}


def score_manifest(manifest_path: Path, evaluations_path: Path) -> dict[str, Any]:
    manifest = sync_manifest_budget(manifest_path)
    evaluations = _read_json(evaluations_path)
    rows = evaluations.get("routes") if isinstance(evaluations.get("routes"), list) else []
    by_route = {str(item.get("route_id")): item for item in rows if isinstance(item, dict)}
    scored = []
    for route in manifest.get("routes", []):
        item = by_route.get(str(route.get("route_id")), {})
        failures = sorted(HARD_FAILURES.intersection(str(value) for value in item.get("hard_failures", [])))
        dimensions = item.get("dimensions") if isinstance(item.get("dimensions"), dict) else {}
        values = {key: float(dimensions.get(key, 0)) for key in SCORE_WEIGHTS}
        if any(not math.isfinite(value) or value < 0 or value > 100 for value in values.values()):
            raise BenchmarkError(f"盲评分必须位于 0–100：{route.get('route_id')}")
        score = 0.0 if failures else round(sum(values[key] * weight for key, weight in SCORE_WEIGHTS.items()), 2)
        route.update({"score": score, "hard_failures": failures})
        scored.append(route)
    scored.sort(key=lambda item: float(item.get("score") or 0), reverse=True)
    for index, route in enumerate(scored, start=1):
        route["rank"] = index
    top_three = [route["route_id"] for route in scored[:3] if float(route.get("score") or 0) >= 75 and not route.get("hard_failures")]
    primary_route = scored[0] if scored and float(scored[0].get("score") or 0) >= 85 and not scored[0].get("hard_failures") else None
    primary = primary_route["route_id"] if primary_route else None
    backup_route = next((
        route for route in scored[1:]
        if (
            primary_route is not None
            and route.get("provider") != primary_route.get("provider")
            and float(route.get("score") or 0) >= 75
            and not route.get("hard_failures")
        )
    ), None)
    backup = backup_route["route_id"] if backup_route else None
    manifest["routes"] = sorted(scored, key=lambda item: item["rank"])
    manifest["selection"] = {
        "top_three": top_three,
        "primary": primary,
        "backup": backup,
        "ai_enhanced_default_eligible": bool(len(top_three) == 3 and primary and backup),
    }
    manifest["status"] = "scored" if manifest["selection"]["ai_enhanced_default_eligible"] else "failed"
    manifest["updated_at"] = _now()
    _atomic_json(manifest_path, manifest)
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    subparsers = parser.add_subparsers(dest="command", required=True)
    init = subparsers.add_parser("init")
    init.add_argument("--output", type=Path, required=True)
    init.add_argument("--pin", action="append", default=[])
    init.add_argument("--estimate", action="append", default=[])
    init.add_argument("--usd-cny", type=float)
    status = subparsers.add_parser("status")
    reserve = subparsers.add_parser("reserve")
    reserve.add_argument("--manifest", type=Path, required=True)
    reserve.add_argument("--route-id", required=True)
    reserve.add_argument("--phase", required=True, choices=["round_1", "round_2", "round_3", "retry"])
    reserve.add_argument("--request-sha256", required=True)
    reserve.add_argument("--estimated-cost-cny", type=float, required=True)
    score = subparsers.add_parser("score")
    score.add_argument("--manifest", type=Path, required=True)
    score.add_argument("--evaluations", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "status":
        result = credential_readiness(_read_json(args.registry))
    elif args.command == "init":
        result = init_manifest(args.registry, args.output, args.pin, args.estimate, args.usd_cny)
    elif args.command == "reserve":
        result = reserve_operation(args.manifest, args.route_id, args.phase, args.request_sha256, args.estimated_cost_cny)
    else:
        result = score_manifest(args.manifest, args.evaluations)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BenchmarkError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        raise SystemExit(2)
