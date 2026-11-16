#!/usr/bin/env python3
"""Runtime image-account policy for ordinary Echo Founder users.

The paid ten-route benchmark remains an internal release/default gate. A user
may explicitly enable AI with one configured account when that provider has a
bundled production route; the benchmark is not a prerequisite for that choice.
"""
from __future__ import annotations

import json
import math
import os
import fcntl
import hashlib
import tempfile
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any


SCHEMA = "echo-founder.image-account-policy.v1"
RUNTIME_ROUTE_CATALOG_SCHEMA = "echo-founder.runtime-image-route-catalog.v1"
RUNTIME_ROUTE_CATALOG_PATH = Path(__file__).resolve().parents[1] / "config" / "runtime-image-routes.json"
CREDENTIALS = {
    "image_openrouter": {"provider": "openrouter", "env": "OPENROUTER_API_KEY"},
    "image_replicate": {"provider": "replicate", "env": "REPLICATE_API_TOKEN"},
    "image_ark": {"provider": "ark", "env": "ARK_API_KEY"},
    "image_dashscope": {"provider": "dashscope", "env": "DASHSCOPE_API_KEY"},
    "image_zai": {"provider": "zai", "env": "ZAI_API_KEY"},
    "image_minimax": {"provider": "minimax", "env": "MINIMAX_API_KEY"},
}
PRESET_ORDERS = {
    "model_richness": ["image_openrouter", "image_ark", "image_dashscope"],
    "domestic_stability": ["image_ark", "image_dashscope", "image_zai"],
    "custom": [],
}


class ImageAccountPolicyError(RuntimeError):
    pass


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


@contextmanager
def _runtime_ledger_lock(root: Path):
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = root / ".runtime-ledger.lock"
    if lock_path.is_symlink():
        raise ImageAccountPolicyError("运行时付费账本锁不安全")
    with lock_path.open("a+", encoding="utf-8") as handle:
        os.chmod(lock_path, 0o600)
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def default_policy() -> dict[str, Any]:
    return {
        "schema_version": SCHEMA,
        "preset": "model_richness",
        "primary_provider": None,
        "backup_provider": None,
        "advanced_provider": None,
        "budgets_cny": {
            "per_call_limit": 5.0,
            "per_task_limit": 20.0,
            "monthly_reminder": 100.0,
        },
        "first_paid_call_confirmed": False,
        "updated_at": "",
    }


def _provider_id(value: Any) -> str | None:
    return value if isinstance(value, str) and value in CREDENTIALS else None


def _budget(value: Any, fallback: float, minimum: float, maximum: float) -> float:
    if isinstance(value, bool):
        return fallback
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return round(result, 2) if math.isfinite(result) and minimum <= result <= maximum else fallback


def normalize_policy(value: Any) -> dict[str, Any]:
    fallback = default_policy()
    raw = value if isinstance(value, dict) else {}
    budgets = raw.get("budgets_cny") if isinstance(raw.get("budgets_cny"), dict) else {}
    preset = raw.get("preset") if raw.get("preset") in PRESET_ORDERS else "model_richness"
    primary = _provider_id(raw.get("primary_provider"))
    backup = _provider_id(raw.get("backup_provider"))
    advanced = _provider_id(raw.get("advanced_provider"))
    if backup == primary:
        backup = None
    if advanced in {primary, backup}:
        advanced = None
    per_call = _budget(budgets.get("per_call_limit"), 5.0, 0.1, 40.0)
    per_task = _budget(budgets.get("per_task_limit"), 20.0, per_call, 100.0)
    return {
        "schema_version": SCHEMA,
        "preset": preset,
        "primary_provider": primary,
        "backup_provider": backup,
        "advanced_provider": advanced,
        "budgets_cny": {
            "per_call_limit": per_call,
            "per_task_limit": per_task,
            "monthly_reminder": _budget(budgets.get("monthly_reminder"), 100.0, 1.0, 10_000.0),
        },
        "first_paid_call_confirmed": raw.get("first_paid_call_confirmed") is True,
        "updated_at": str(raw.get("updated_at") or ""),
    }


def policy_path() -> Path | None:
    configured = str(os.environ.get("AIFIOS_IMAGE_ACCOUNT_POLICY") or "").strip()
    if configured:
        candidate = Path(configured).expanduser()
        return candidate if candidate.is_absolute() else None
    user_data = str(os.environ.get("AIFIOS_DESKTOP_USER_DATA_DIR") or "").strip()
    if not user_data:
        return None
    root = Path(user_data).expanduser()
    return root / "image-account-policy.json" if root.is_absolute() else None


def load_policy() -> dict[str, Any]:
    path = policy_path()
    if path is None or not path.exists():
        return default_policy()
    if path.is_symlink() or not path.is_file() or path.stat().st_size <= 0 or path.stat().st_size > 64 * 1024:
        raise ImageAccountPolicyError("生图账户策略文件不安全")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ImageAccountPolicyError("生图账户策略无法读取") from exc
    if not isinstance(raw, dict) or raw.get("schema_version") != SCHEMA:
        raise ImageAccountPolicyError("生图账户策略版本不受支持")
    return normalize_policy(raw)


def configured_credentials() -> list[str]:
    marker = os.environ.get("AIFIOS_IMAGE_ACCOUNT_IDS")
    if marker is not None:
        marked = {item.strip() for item in marker.split(",") if item.strip()}
        return [credential_id for credential_id in CREDENTIALS if credential_id in marked]
    return [
        credential_id
        for credential_id, definition in CREDENTIALS.items()
        if str(os.environ.get(str(definition["env"])) or "").strip()
    ]


def effective_credentials(policy: dict[str, Any], configured: list[str] | None = None) -> list[str]:
    available = set(configured if configured is not None else configured_credentials())
    preset = str(policy.get("preset") or "model_richness")
    candidates = [
        policy.get("primary_provider"),
        policy.get("backup_provider"),
        policy.get("advanced_provider"),
        *PRESET_ORDERS.get(preset, []),
        *CREDENTIALS,
    ]
    selected: list[str] = []
    for value in candidates:
        if isinstance(value, str) and value in available and value not in selected:
            selected.append(value)
    return selected[:3]


def runtime_status(policy: dict[str, Any] | None = None) -> dict[str, Any]:
    normalized = normalize_policy(policy) if policy is not None else load_policy()
    configured = configured_credentials()
    active = effective_credentials(normalized, configured)
    return {
        "configured": len(configured),
        "active": active,
        "runtime_image_ready": len(active) >= 1,
        "runtime_backup_ready": len(active) >= 2,
        "first_paid_call_confirmed": normalized["first_paid_call_confirmed"],
    }


def accepted_route_candidates(
    manifest: dict[str, Any],
    policy: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    normalized = normalize_policy(policy) if policy is not None else load_policy()
    if normalized.get("first_paid_call_confirmed") is not True:
        raise ImageAccountPolicyError("首次付费调用尚未确认预算")
    active = effective_credentials(normalized)
    if not active:
        raise ImageAccountPolicyError("尚未配置可用的生图账户")
    provider_order = [str(CREDENTIALS[item]["provider"]) for item in active]
    routes = []
    for route in manifest.get("routes", []):
        if not isinstance(route, dict) or str(route.get("provider") or "") not in provider_order:
            continue
        score = route.get("score")
        estimate = route.get("estimated_cost_cny")
        if (
            not route.get("model_id")
            or route.get("hard_failures")
            or not isinstance(score, (int, float))
            or isinstance(score, bool)
            or score < 75
            or not isinstance(estimate, (int, float))
            or isinstance(estimate, bool)
            or estimate <= 0
        ):
            continue
        routes.append(route)
    routes.sort(key=lambda item: (
        provider_order.index(str(item.get("provider"))),
        int(item.get("rank")) if isinstance(item.get("rank"), int) else 10_000,
        -float(item.get("score") or 0),
        str(item.get("route_id") or ""),
    ))
    if not routes:
        raise ImageAccountPolicyError("已配置账户没有通过内部验收的正式模型路由")
    primary_provider = str(routes[0].get("provider") or "")
    primary = routes[0]
    backup = next((route for route in routes if str(route.get("provider") or "") != primary_provider), None)
    used_providers = {primary_provider}
    if backup is not None:
        used_providers.add(str(backup.get("provider") or ""))
    advanced = next((
        route for route in routes
        if str(route.get("provider") or "") not in used_providers
    ), None)
    return [item for item in (primary, backup, advanced) if item is not None]


def load_runtime_route_catalog(path: Path | str | None = None) -> dict[str, Any]:
    """Load the shipped user-runtime route catalog without exposing secrets."""
    configured = str(os.environ.get("AIFIOS_IMAGE_RUNTIME_ROUTE_CATALOG") or "").strip()
    if path is not None:
        candidate = Path(path).expanduser()
    elif configured:
        candidate = Path(configured).expanduser()
    else:
        candidate = RUNTIME_ROUTE_CATALOG_PATH
    if not candidate.is_absolute() or candidate.is_symlink() or not candidate.is_file():
        raise ImageAccountPolicyError("正式生图运行路由清单缺失或不安全")
    if candidate.stat().st_size <= 0 or candidate.stat().st_size > 256 * 1024:
        raise ImageAccountPolicyError("正式生图运行路由清单大小无效")
    try:
        catalog = json.loads(candidate.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ImageAccountPolicyError("正式生图运行路由清单无法读取") from exc
    routes = catalog.get("routes") if isinstance(catalog, dict) else None
    if (
        not isinstance(catalog, dict)
        or catalog.get("schema_version") != RUNTIME_ROUTE_CATALOG_SCHEMA
        or catalog.get("status") != "ready"
        or not isinstance(catalog.get("benchmark_id"), str)
        or not catalog.get("benchmark_id")
        or not isinstance(routes, list)
    ):
        raise ImageAccountPolicyError("正式生图运行路由清单版本或状态无效")
    provider_by_credential = {
        credential_id: str(definition["provider"])
        for credential_id, definition in CREDENTIALS.items()
    }
    seen: set[str] = set()
    for route in routes:
        if not isinstance(route, dict):
            raise ImageAccountPolicyError("正式生图运行路由条目无效")
        route_id = str(route.get("route_id") or "")
        credential_id = str(route.get("credential_id") or "")
        model_id = str(route.get("model_id") or "")
        estimate = route.get("estimated_cost_cny")
        if (
            not route_id
            or route_id in seen
            or credential_id not in provider_by_credential
            or route.get("provider") != provider_by_credential[credential_id]
            or not model_id
            or len(model_id) > 200
            or route.get("runtime_eligible") is not True
            or not isinstance(estimate, (int, float))
            or isinstance(estimate, bool)
            or not math.isfinite(float(estimate))
            or float(estimate) <= 0
        ):
            raise ImageAccountPolicyError(f"正式生图运行路由无效：{route_id or '<missing>'}")
        seen.add(route_id)
    return catalog


def runtime_route_candidates(
    catalog: dict[str, Any],
    policy: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Select user-runtime routes independently from internal benchmark scores."""
    normalized = normalize_policy(policy) if policy is not None else load_policy()
    if normalized.get("first_paid_call_confirmed") is not True:
        raise ImageAccountPolicyError("首次付费调用尚未确认预算")
    active = effective_credentials(normalized)
    if not active:
        raise ImageAccountPolicyError("尚未配置可用的生图账户")
    active_order = {credential_id: index for index, credential_id in enumerate(active)}
    routes = [
        route for route in catalog.get("routes", [])
        if isinstance(route, dict)
        and route.get("runtime_eligible") is True
        and str(route.get("credential_id") or "") in active_order
    ]
    routes.sort(key=lambda item: (
        active_order[str(item.get("credential_id") or "")],
        int(item.get("priority")) if isinstance(item.get("priority"), int) else 10_000,
        str(item.get("route_id") or ""),
    ))
    if not routes:
        raise ImageAccountPolicyError("已配置账户暂时没有可直接运行的正式生图模型")
    selected: list[dict[str, Any]] = []
    used_providers: set[str] = set()
    for route in routes:
        provider = str(route.get("provider") or "")
        if provider in used_providers:
            continue
        selected.append(route)
        used_providers.add(provider)
        if len(selected) >= 3:
            break
    return selected


def budget_limits(policy: dict[str, Any] | None = None) -> dict[str, float]:
    normalized = normalize_policy(policy) if policy is not None else load_policy()
    return {
        "per_call_limit": float(normalized["budgets_cny"]["per_call_limit"]),
        "per_task_limit": float(normalized["budgets_cny"]["per_task_limit"]),
        "monthly_reminder": float(normalized["budgets_cny"]["monthly_reminder"]),
    }


def runtime_ledger_root() -> Path:
    configured = str(os.environ.get("AIFIOS_IMAGE_RUNTIME_LEDGER_DIR") or "").strip()
    if configured:
        root = Path(configured).expanduser()
    else:
        user_data = str(os.environ.get("AIFIOS_DESKTOP_USER_DATA_DIR") or "").strip()
        root = Path(user_data).expanduser() / "image-runtime-operations" if user_data else Path()
    if not configured and not str(os.environ.get("AIFIOS_DESKTOP_USER_DATA_DIR") or "").strip():
        raise ImageAccountPolicyError("桌面运行时付费账本目录未配置")
    if not root.is_absolute() or root.is_symlink():
        raise ImageAccountPolicyError("运行时付费账本目录不安全")
    return root


def reserve_runtime_operation(
    *,
    benchmark_id: str,
    route_id: str,
    request_sha256: str,
    operation_key: str,
    task_key: str,
    estimated_cost_cny: float,
    per_call_limit: float,
    per_task_limit: float,
) -> dict[str, Any]:
    if not all(isinstance(value, str) and value for value in (benchmark_id, route_id, operation_key, task_key)):
        raise ImageAccountPolicyError("运行时付费操作缺少幂等标识")
    if len(request_sha256) != 64 or any(char not in "0123456789abcdef" for char in request_sha256):
        raise ImageAccountPolicyError("运行时付费请求摘要无效")
    values = (estimated_cost_cny, per_call_limit, per_task_limit)
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)) for value in values):
        raise ImageAccountPolicyError("运行时付费预算无效")
    if estimated_cost_cny <= 0 or estimated_cost_cny > per_call_limit or per_call_limit > per_task_limit:
        raise ImageAccountPolicyError("运行时付费调用超过单次或单任务预算")
    root = runtime_ledger_root()
    task_id = hashlib.sha256(task_key.encode("utf-8")).hexdigest()[:32]
    task_dir = root / task_id
    operation_id = hashlib.sha256(
        f"runtime\0{benchmark_id}\0{route_id}\0{request_sha256}\0{operation_key}".encode("utf-8")
    ).hexdigest()[:32]
    operation_path = task_dir / f"{operation_id}.json"
    with _runtime_ledger_lock(root):
        if task_dir.exists() and (task_dir.is_symlink() or not task_dir.is_dir()):
            raise ImageAccountPolicyError("运行时付费任务账本不安全")
        if operation_path.exists():
            if operation_path.is_symlink() or not operation_path.is_file():
                raise ImageAccountPolicyError("运行时付费操作记录不安全")
            existing = json.loads(operation_path.read_text(encoding="utf-8"))
            if not isinstance(existing, dict):
                raise ImageAccountPolicyError("运行时付费操作记录无效")
            return {**existing, "operation_path": str(operation_path)}
        existing_rows = []
        if task_dir.exists():
            for candidate in task_dir.glob("*.json"):
                if candidate.is_symlink() or not candidate.is_file():
                    raise ImageAccountPolicyError("运行时付费任务账本包含不安全文件")
                row = json.loads(candidate.read_text(encoding="utf-8"))
                if not isinstance(row, dict):
                    raise ImageAccountPolicyError("运行时付费任务账本包含无效记录")
                existing_rows.append(row)
        reserved = sum(float(item.get("charged_or_reserved_cny") or 0) for item in existing_rows)
        if reserved + estimated_cost_cny > per_task_limit + 1e-9:
            raise ImageAccountPolicyError("本任务付费预算已达到，禁止发送新请求")
        operation = {
            "schema_version": "echo-founder.paid-image-operation.v1",
            "scope": "runtime",
            "operation_id": operation_id,
            "benchmark_id": benchmark_id,
            "route_id": route_id,
            "task_id": task_id,
            "request_sha256": request_sha256,
            "status": "prepared",
            "retry_allowed": False,
            "estimated_cost_cny": round(float(estimated_cost_cny), 4),
            "actual_cost_cny": None,
            "charged_or_reserved_cny": round(float(estimated_cost_cny), 4),
            "created_at": _now(),
            "updated_at": _now(),
        }
        _atomic_json(operation_path, operation)
        return {**operation, "operation_path": str(operation_path)}
