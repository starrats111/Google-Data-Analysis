#!/usr/bin/env python3
"""
07的令牌状态检查脚本
"""
import sys
from pathlib import Path

backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

from app.config import settings

print("=== 检查新令牌状态 ===")
print("")

token = settings.google_ads_shared_developer_token
print(f"当前令牌: {token}")
print(f"令牌长度: {len(token)} 字符")
print("")

print("=== 问题分析 ===")
print("错误: Developer token is not allowed with project")
print("")
print("可能的原因:")
print("1. ⏳ 新令牌需要等待Google审核（通常需要1-3个工作日）")
print("2. ❌ 新令牌还没有被激活")
print("3. ⚠️  新令牌需要与正确的Google Cloud项目关联")
print("")
print("=== 解决方案 ===")
print("")
print("方案1: 等待Google审核（推荐）")
print("  - 新令牌通常需要1-3个工作日审核")
print("  - 审核通过后才能使用")
print("")
print("方案2: 联系领导确认")
print("  - 确认令牌是否已提交审核")
print("  - 确认令牌状态")
print("")
print("方案3: 暂时使用旧令牌（如果有）")
print("  - 如果系统之前能正常工作，可能有旧令牌")
print("  - 可以暂时回退到旧令牌")

