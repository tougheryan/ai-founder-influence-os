#!/usr/bin/env python3
"""Static checks for frontend LLM provider presets."""
from __future__ import annotations

import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
LLM_CLIENT = REPO_ROOT / "ui" / "lib" / "llm-client.ts"


EXPECTED_MODELS = {
    "openai": "gpt-5.5",
    "deepseek": "deepseek-v4-flash",
    "gemini": "gemini-3.5-flash",
    "anthropic": "claude-opus-4-8",
    "siliconflow": "zai-org/GLM-5.2",
    "dashscope": "qwen3.7-max",
    "moonshot": "kimi-k2.6",
}


def fail(message: str) -> int:
    print(f"FAIL ui model presets: {message}")
    return 1


def find_model(source: str, provider: str) -> str | None:
    pattern = re.compile(
        rf"{re.escape(provider)}:\s*\{{.*?model:\s*['\"]([^'\"]+)['\"]",
        re.DOTALL,
    )
    match = pattern.search(source)
    return match.group(1) if match else None


def main() -> int:
    source = LLM_CLIENT.read_text(encoding="utf-8")

    for provider, expected_model in EXPECTED_MODELS.items():
        actual = find_model(source, provider)
        if actual != expected_model:
            return fail(f"{provider} model expected {expected_model!r}, got {actual!r}")

    required_tokens = [
        "shouldOmitAnthropicSamplingParams",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-sonnet-5",
        "...(!shouldOmitAnthropicSamplingParams(model)",
    ]
    for token in required_tokens:
        if token not in source:
            return fail(f"llm-client.ts missing Anthropic sampling guard token: {token}")

    print("PASS ui model presets")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
