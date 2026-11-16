from __future__ import annotations

import sys
from pathlib import Path


RUNTIME_SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(RUNTIME_SCRIPTS))

from angle_quality import audit_angle


LOW_EVIDENCE_ANGLE = """# 角度清单

## 0. 立项约束
- 立项结论：不通过
- 首发平台：公众号
- 必须使用的素材证据：一次真实访谈中的客户问题和创始人原话
- 不可触碰的风险边界：不补造客户结果、数据或授权

## 推荐角度
### 角度 1：从真实问题切入
- 一句话定位：把一次真实问题整理成可复用的判断
- 目标用户：正在处理相似客户问题的服务型创始人
- 素材证据：访谈中的客户问题和创始人原话
- 商业承接：引导读者预约问题梳理
- 适合平台：公众号首发
- 风险点：不写成客户结果证明

### 角度 2：从方法清单切入
- 一句话定位：把访谈判断整理成行动清单
- 目标用户：需要低成本内容方法的创始人
- 素材证据：访谈中的判断过程
- 商业承接：引导读者领取问题清单
- 适合平台：公众号首发
- 风险点：不承诺具体转化结果

## 角度对比表
| 角度 | 素材支撑 | 平台适配 | 传播潜力 | 商业承接 | 风险 |
|---|---|---|---|---|---|
| 问题切入 | 高 | 公众号 | 中 | 有 | 低 |
| 方法清单 | 中 | 公众号 | 中 | 有 | 低 |

## 建议
- 首选角度：从真实问题切入
- 进入 content-breakdown 的约束：只使用一手素材并保留风险边界
"""


def test_low_evidence_decision_is_reviewable_not_blocking() -> None:
    result = audit_angle(LOW_EVIDENCE_ANGLE)

    assert result["status"] == "review_required"
    assert result["blocking_issues"] == []
    assert any("低证据创作继续" in issue for issue in result["review_issues"])
