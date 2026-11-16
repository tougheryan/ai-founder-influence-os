#!/usr/bin/env python3
"""Direct paid image gateway bound to a frozen Echo Founder benchmark.

Every request is reserved in the RMB ledger before network dispatch. Network
ambiguity is recorded as ``unknown`` and is never automatically paid again.
Critical Chinese copy is intentionally outside this gateway and must be added
later by the deterministic HTML/SVG renderer.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from image_provider_benchmark import BenchmarkError, _atomic_json, _read_json, reserve_operation, sync_manifest_budget
from image_account_policy import ImageAccountPolicyError, reserve_runtime_operation


MAX_IMAGE_BYTES = 32 * 1024 * 1024
PROVIDER_ENV = {
    "openrouter": "OPENROUTER_API_KEY",
    "replicate": "REPLICATE_API_TOKEN",
    "ark": "ARK_API_KEY",
    "dashscope": "DASHSCOPE_API_KEY",
    "zai": "ZAI_API_KEY",
    "minimax": "MINIMAX_API_KEY",
}


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _request_json(url: str, key: str, payload: dict[str, Any], extra_headers: dict[str, str] | None = None, timeout: int = 180) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        **(extra_headers or {}),
    }
    request = Request(url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), headers=headers, method="POST")
    with urlopen(request, timeout=timeout) as response:
        value = json.loads(response.read().decode("utf-8"))
    if not isinstance(value, dict):
        raise BenchmarkError("生图服务响应不是 JSON 对象")
    return value


def _get_json(url: str, key: str, timeout: int = 60) -> dict[str, Any]:
    request = Request(url, headers={"Authorization": f"Bearer {key}", "Accept": "application/json"})
    with urlopen(request, timeout=timeout) as response:
        value = json.loads(response.read().decode("utf-8"))
    if not isinstance(value, dict):
        raise BenchmarkError("生图任务查询响应无效")
    return value


def _image_bytes_from_payload(value: Any) -> tuple[bytes, str]:
    candidates: list[tuple[str, str]] = []

    def visit(item: Any) -> None:
        if isinstance(item, dict):
            for key, nested in item.items():
                lowered = str(key).lower()
                if isinstance(nested, str) and lowered in {"b64_json", "image_base64", "base64"}:
                    candidates.append(("base64", nested))
                elif isinstance(nested, str) and lowered in {"url", "image_url", "output"} and nested.startswith("https://"):
                    candidates.append(("url", nested))
                else:
                    visit(nested)
        elif isinstance(item, list):
            for nested in item:
                if isinstance(nested, str) and nested.startswith("https://"):
                    candidates.append(("url", nested))
                else:
                    visit(nested)

    visit(value)
    if not candidates:
        raise BenchmarkError("服务返回成功，但没有找到图像数据")
    kind, raw = candidates[0]
    if kind == "base64":
        try:
            content = base64.b64decode(raw, validate=True)
        except (ValueError, TypeError) as exc:
            raise BenchmarkError("服务返回的 Base64 图片无效") from exc
        media_type = "image/png"
    else:
        parsed = urlparse(raw)
        if parsed.scheme != "https" or not parsed.netloc:
            raise BenchmarkError("服务返回了不安全的图片地址")
        with urlopen(Request(raw, headers={"Accept": "image/*"}), timeout=120) as response:
            content = response.read(MAX_IMAGE_BYTES + 1)
            media_type = response.headers.get_content_type()
    if not content or len(content) > MAX_IMAGE_BYTES:
        raise BenchmarkError("图片为空或超过 32MB 上限")
    signatures = (
        content.startswith(b"\x89PNG\r\n\x1a\n"),
        content.startswith(b"\xff\xd8\xff"),
        content.startswith(b"RIFF") and content[8:12] == b"WEBP",
        content.lstrip().startswith(b"<svg"),
    )
    if not any(signatures):
        raise BenchmarkError("服务返回的文件不是完整 PNG、JPEG、WebP 或 SVG")
    if not media_type.startswith("image/"):
        media_type = "image/png"
    return content, media_type


def _aspect_size(provider: str, aspect_ratio: str) -> str:
    values = {
        "16:9": {"ark": "2048x1152", "zai": "1344x768", "openrouter": "16:9"},
        "3:4": {"ark": "1536x2048", "zai": "960x1280", "openrouter": "3:4"},
        "1:1": {"ark": "2048x2048", "zai": "1024x1024", "openrouter": "1:1"},
    }
    if aspect_ratio not in values:
        raise BenchmarkError("只允许 16:9、3:4 或 1:1")
    return values[aspect_ratio].get(provider, aspect_ratio)


def _openrouter(model: str, prompt: str, aspect_ratio: str, key: str) -> dict[str, Any]:
    return _request_json(
        "https://openrouter.ai/api/v1/images",
        key,
        {"model": model, "prompt": prompt, "aspect_ratio": _aspect_size("openrouter", aspect_ratio), "n": 1},
    )


def _openai_compatible(provider: str, model: str, prompt: str, aspect_ratio: str, key: str) -> dict[str, Any]:
    endpoints = {
        "ark": os.environ.get("ARK_IMAGE_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3/images/generations"),
        "zai": os.environ.get("ZAI_IMAGE_BASE_URL", "https://open.bigmodel.cn/api/paas/v4/images/generations"),
    }
    return _request_json(
        endpoints[provider],
        key,
        {"model": model, "prompt": prompt, "size": _aspect_size(provider, aspect_ratio), "n": 1},
    )


def _minimax(model: str, prompt: str, aspect_ratio: str, key: str) -> dict[str, Any]:
    return _request_json(
        "https://api.minimaxi.com/v1/image_generation",
        key,
        {
            "model": model,
            "prompt": prompt,
            "aspect_ratio": aspect_ratio,
            "response_format": "base64",
            "n": 1,
            "prompt_optimizer": False,
            "aigc_watermark": False,
        },
    )


def _dashscope(model: str, prompt: str, aspect_ratio: str, key: str) -> dict[str, Any]:
    workspace_id = str(os.environ.get("DASHSCOPE_WORKSPACE_ID") or "").strip()
    region = str(os.environ.get("DASHSCOPE_REGION") or "cn-beijing").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{3,128}", workspace_id):
        raise BenchmarkError("DashScope 真实路由需要在钥匙串账户配置中提供 Workspace ID")
    if region not in {"cn-beijing", "ap-southeast-1"}:
        raise BenchmarkError("DashScope region 仅支持 cn-beijing 或 ap-southeast-1")
    endpoint = f"https://{workspace_id}.{region}.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
    size = "2048*1152" if aspect_ratio == "16:9" else "1536*2048" if aspect_ratio == "3:4" else "2048*2048"
    return _request_json(
        endpoint,
        key,
        {
            "model": model,
            "input": {"messages": [{"role": "user", "content": [{"text": prompt}]}]},
            "parameters": {"n": 1, "size": size},
        },
    )


def _replicate(model: str, prompt: str, aspect_ratio: str, key: str) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", model):
        raise BenchmarkError("Replicate 冻结模型 ID 必须为 owner/model")
    response = _request_json(
        f"https://api.replicate.com/v1/models/{model}/predictions",
        key,
        {"input": {"prompt": prompt, "aspect_ratio": aspect_ratio, "output_format": "png"}},
        extra_headers={"Prefer": "wait=60"},
        timeout=75,
    )
    status = str(response.get("status") or "")
    if status == "succeeded":
        return response
    prediction_id = str(response.get("id") or "")
    if not prediction_id:
        raise BenchmarkError("Replicate 未返回可查询的 prediction ID")
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        time.sleep(2)
        response = _get_json(f"https://api.replicate.com/v1/predictions/{prediction_id}", key)
        status = str(response.get("status") or "")
        if status == "succeeded":
            return response
        if status in {"failed", "canceled"}:
            raise BenchmarkError(f"Replicate 任务{status}，不会自动重付费")
    raise TimeoutError("Replicate 任务结果未知，禁止自动重付费")


def _dispatch(provider: str, model: str, prompt: str, aspect_ratio: str, key: str) -> dict[str, Any]:
    if provider == "openrouter":
        return _openrouter(model, prompt, aspect_ratio, key)
    if provider in {"ark", "zai"}:
        return _openai_compatible(provider, model, prompt, aspect_ratio, key)
    if provider == "minimax":
        return _minimax(model, prompt, aspect_ratio, key)
    if provider == "dashscope":
        return _dashscope(model, prompt, aspect_ratio, key)
    if provider == "replicate":
        return _replicate(model, prompt, aspect_ratio, key)
    raise BenchmarkError(f"未实现的直接付费 provider：{provider}")


def generate(args: argparse.Namespace) -> dict[str, Any]:
    manifest = _read_json(args.manifest)
    routes = {str(item.get("route_id")): item for item in manifest.get("routes", []) if isinstance(item, dict)}
    route = routes.get(args.route_id)
    if not route or not str(route.get("model_id") or ""):
        raise BenchmarkError("路由不属于当前 benchmark 或模型尚未冻结")
    provider = str(route.get("provider") or "")
    env_name = PROVIDER_ENV.get(provider)
    key = str(os.environ.get(env_name or "") or "")
    if not key:
        raise BenchmarkError(f"{provider} 付费账户密钥未进入运行服务")
    prompt = args.prompt_file.read_text(encoding="utf-8").strip()
    if not prompt or len(prompt) > 12_000:
        raise BenchmarkError("视觉提示词为空或超过 12000 字符")
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", args.operation_key):
        raise BenchmarkError("付费生图 operation key 格式无效")
    request_payload = {
        "benchmark_id": manifest.get("benchmark_id"),
        "route_id": args.route_id,
        "model_id": route.get("model_id"),
        "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
        "aspect_ratio": args.aspect_ratio,
        "operation_key": args.operation_key,
    }
    request_sha256 = hashlib.sha256(json.dumps(request_payload, sort_keys=True).encode()).hexdigest()
    ledger_scope = str(getattr(args, "ledger_scope", "benchmark") or "benchmark")
    if ledger_scope == "runtime":
        try:
            operation = reserve_runtime_operation(
                benchmark_id=str(manifest.get("benchmark_id") or ""),
                route_id=args.route_id,
                request_sha256=request_sha256,
                operation_key=args.operation_key,
                task_key=str(getattr(args, "runtime_task_key", "") or ""),
                estimated_cost_cny=args.estimated_cost_cny,
                per_call_limit=float(getattr(args, "per_call_limit", 0) or 0),
                per_task_limit=float(getattr(args, "per_task_limit", 0) or 0),
            )
        except ImageAccountPolicyError as exc:
            raise BenchmarkError(str(exc)) from exc
    else:
        operation = reserve_operation(
            args.manifest,
            args.route_id,
            args.phase,
            request_sha256,
            args.estimated_cost_cny,
        )
    operation_path = Path(str(operation.pop("operation_path", "")))
    if operation.get("status") != "prepared":
        return {"ok": operation.get("status") == "succeeded", "operation": operation}
    operation.update({"status": "dispatched", "dispatched_at": _now(), "updated_at": _now()})
    _atomic_json(operation_path, operation)
    started = time.monotonic()
    try:
        response = _dispatch(provider, str(route["model_id"]), prompt, args.aspect_ratio, key)
        content, media_type = _image_bytes_from_payload(response)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(content)
        output_sha256 = hashlib.sha256(content).hexdigest()
        usage = response.get("usage") if isinstance(response.get("usage"), dict) else {}
        cost_usd = usage.get("cost") if isinstance(usage.get("cost"), (int, float)) else None
        usd_cny = (manifest.get("exchange_rate") or {}).get("usd_cny") if isinstance(manifest.get("exchange_rate"), dict) else None
        actual_cny = float(cost_usd) * float(usd_cny) if cost_usd is not None and isinstance(usd_cny, (int, float)) else None
        operation.update({
            "status": "succeeded",
            "retry_allowed": False,
            "provider_request_id": str(response.get("id") or response.get("request_id") or ""),
            "duration_ms": round((time.monotonic() - started) * 1000),
            "media_type": media_type,
            "output_sha256": output_sha256,
            "actual_cost_cny": round(actual_cny, 4) if actual_cny is not None else None,
            "charged_or_reserved_cny": round(actual_cny, 4) if actual_cny is not None else operation["estimated_cost_cny"],
            "cost_source": "provider_usage" if actual_cny is not None else "reserved_estimate_pending_invoice",
            "completed_at": _now(),
            "updated_at": _now(),
        })
        _atomic_json(operation_path, operation)
        if ledger_scope == "benchmark":
            sync_manifest_budget(args.manifest)
        return {"ok": True, "output": str(args.output), "operation": operation}
    except HTTPError as exc:
        body = exc.read(2048).decode("utf-8", errors="replace")
        operation.update({
            "status": "failed",
            "retry_allowed": True,
            "error": f"HTTP {exc.code}: {body[:500]}",
            "duration_ms": round((time.monotonic() - started) * 1000),
            "updated_at": _now(),
        })
        _atomic_json(operation_path, operation)
        if ledger_scope == "benchmark":
            sync_manifest_budget(args.manifest)
        return {
            "ok": False,
            "error": "付费请求明确失败；允许切换冻结备用路由",
            "operation": operation,
        }
    except (URLError, TimeoutError, OSError) as exc:
        operation.update({
            "status": "unknown",
            "retry_allowed": False,
            "error": str(exc)[:500],
            "duration_ms": round((time.monotonic() - started) * 1000),
            "updated_at": _now(),
        })
        _atomic_json(operation_path, operation)
        if ledger_scope == "benchmark":
            sync_manifest_budget(args.manifest)
        return {
            "ok": False,
            "error": "付费请求结果不明；已禁止自动重付费，请人工核账",
            "operation": operation,
        }
    except BenchmarkError as exc:
        operation.update({
            "status": "unknown",
            "retry_allowed": False,
            "error": str(exc)[:500],
            "duration_ms": round((time.monotonic() - started) * 1000),
            "updated_at": _now(),
        })
        _atomic_json(operation_path, operation)
        if ledger_scope == "benchmark":
            sync_manifest_budget(args.manifest)
        return {
            "ok": False,
            "error": str(exc),
            "operation": operation,
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--route-id", required=True)
    parser.add_argument("--phase", required=True, choices=["round_1", "round_2", "round_3", "retry"])
    parser.add_argument("--prompt-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--aspect-ratio", default="16:9", choices=["16:9", "3:4", "1:1"])
    parser.add_argument("--estimated-cost-cny", type=float, required=True)
    parser.add_argument("--operation-key", required=True)
    parser.add_argument("--ledger-scope", choices=["benchmark", "runtime"], default="benchmark")
    parser.add_argument("--runtime-task-key", default="")
    parser.add_argument("--per-call-limit", type=float, default=0)
    parser.add_argument("--per-task-limit", type=float, default=0)
    args = parser.parse_args()
    result = generate(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BenchmarkError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        raise SystemExit(2)
