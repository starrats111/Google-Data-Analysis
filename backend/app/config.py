"""
应用配置
"""
import json
from pathlib import Path
from typing import Any, List, Set

try:
    from pydantic_settings import BaseSettings, SettingsConfigDict
except ImportError:
    # 兼容：在 pydantic v2 未安装 pydantic-settings 时，仍可使用 v1 兼容层
    try:
        from pydantic.v1 import BaseSettings  # type: ignore
    except Exception:
        # 兼容 pydantic 1.x
        from pydantic import BaseSettings  # type: ignore
    SettingsConfigDict = None


def _parse_str_list(value: Any) -> List[str]:
    """Parse list-like env values.

    Supports:
    - JSON list: '["http://a","http://b"]'
    - comma-separated: 'http://a,http://b'
    - already-a-list
    """
    if value is None:
        return []
    if isinstance(value, list):
        return [str(x).strip() for x in value if str(x).strip()]
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return []
        # try JSON first
        if (s.startswith("[") and s.endswith("]")) or (s.startswith('"') and s.endswith('"')):
            try:
                parsed = json.loads(s)
                if isinstance(parsed, list):
                    return [str(x).strip() for x in parsed if str(x).strip()]
                if isinstance(parsed, str) and parsed.strip():
                    return [parsed.strip()]
            except Exception:
                pass
        # fallback: comma-separated
        return [part.strip() for part in s.split(",") if part.strip()]
    return [str(value).strip()] if str(value).strip() else []


class Settings(BaseSettings):
    # 环境配置
    ENVIRONMENT: str = "development"  # development / production
    
    # 数据库配置
    DATABASE_URL: str = "sqlite:///./google_analysis.db"
    
    # JWT配置
    SECRET_KEY: str = "your-secret-key-change-in-production"
    REFRESH_SECRET_KEY: str = ""  # Refresh Token 专用密钥，从环境变量读取
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 1440  # 24小时
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7  # Refresh Token 有效期
    
    # Cookie 配置
    COOKIE_SECURE: bool = True  # 生产环境 True，开发环境自动降级
    COOKIE_SAMESITE: str = "lax"  # lax / strict / none
    
    # 文件上传配置
    UPLOAD_FOLDER: str = "uploads"
    MAX_FILE_SIZE: int = 10 * 1024 * 1024  # 10MB
    ALLOWED_EXTENSIONS: Set[str] = {'.xlsx', '.xls', '.csv'}
    
    # 导出配置
    EXPORT_FOLDER: str = "excel"
    TEMPLATE_FILE: str = "excel/表6.xlsx"
    ANALYSIS_TEMPLATE_FILE: str = "excel/分析表.xlsx"  # 分析表模板路径
    STAGE_LABEL_TEMPLATE_FILE: str = "excel/表4.xlsx"  # 阶段标签分析模板路径
    ANOMALY_TEMPLATE_FILE: str = "excel/表5.xlsx"  # 异常类型模板路径
    
    # 用户配置
    MANAGER_USERNAME: str = ""
    EMPLOYEE_COUNT: int = 10
    
    # 同步安全限制
    MAX_SYNC_DATE_RANGE_DAYS: int = 180
    
    # 露出功能配置
    LUCHU_REVIEWERS: str = "wj07,wj02"
    LUCHU_SELF_REVIEW_ENABLED: bool = False
    LUCHU_AUTHORIZED_USERS: str = "wj01,wj02,wj03,wj04,wj05,wj06,wj07,wj08,wj09,wj10"
    
    # CORS配置
    CORS_ORIGINS: List[str] = [
        "https://google-data-analysis.top",
        "https://www.google-data-analysis.top",
        "https://api.google-data-analysis.top",
        "https://google-data-analysis.pages.dev",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ]

    # ===== Google Ads API 配置 =====
    # 开发者令牌（必需）
    google_ads_shared_developer_token: str = ""
    
    # OAuth配置（旧版，保留兼容）
    google_ads_shared_client_id: str = ""
    google_ads_shared_client_secret: str = ""
    
    # 服务账号配置（新版推荐）
    # 方式1：JSON密钥文件路径
    google_ads_service_account_file: str = ""
    # 方式2：JSON密钥内容（Base64编码，适合云部署）
    google_ads_service_account_json_base64: str = ""
    
    # 同步配置
    google_ads_sync_batch_size: int = 10  # 每批同步的MCC数量
    google_ads_sync_delay_seconds: float = 2.0  # 批次间延迟秒数
    google_ads_request_delay_seconds: float = 1.0  # 单个请求间延迟秒数
    google_ads_sync_hour: int = 4  # 每日同步时间（小时，北京时间）
    
    # 汇率配置
    # 用于当谷歌广告表1为人民币(CNY/RMB)时，将费用/CPC等换算为美元(USD)
    # 含义：1 USD = CNY_TO_USD_RATE CNY，因此 CNY -> USD 需要除以该值
    CNY_TO_USD_RATE: float = 7.2

    # ===== AI 点评（可选）=====
    # 若不配置 OPENAI_API_KEY，则系统自动使用规则版点评（不影响功能）
    OPENAI_API_KEY: str = ""
    OPENAI_MODEL: str = "gpt-4o-mini"
    
    # ===== Gemini AI 配置（哈基米中转）=====
    # 哈基米API站: https://api.gemai.cc
    gemini_api_key: str = ""
    gemini_base_url: str = "https://api.gemai.cc"
    # 主模型（日常使用，最便宜）- 注意哈基米模型需要带前缀
    gemini_model: str = "[福利]gemini-2.5-flash-lite"
    # 备用模型1（最新模型）
    gemini_model_advanced: str = "[福利]gemini-3-flash-preview"
    # 备用模型2（带思考链，复杂分析）
    gemini_model_thinking: str = "[福利]gemini-3-flash-preview-thinking"
    
    # ===== Claude AI 配置（露出功能）=====
    # Claude API Key（从哈基米读取，与 Gemini 相同方式）
    CLAUDE_API_KEY: str = ""
    CLAUDE_BASE_URL: str = "https://api.gemai.cc"  # 哈基米代理地址
    CLAUDE_MODEL: str = "[特价B]claude-sonnet-4-20250514"  # 主模型：哈基米Sonnet（性价比高）
    CLAUDE_MODEL_FALLBACK: str = "[特价B]claude-opus-4-5-20251101"  # 备用模型：哈基米Opus
    
    # ===== GitHub 配置（露出功能发布）=====
    GITHUB_TOKEN: str = ""
    GITHUB_OWNER: str = "starrats111"
    
    OPENAI_BASE_URL: str = "https://api.openai.com/v1"
    
    if SettingsConfigDict is not None:
        # Pydantic v2
        from pydantic import field_validator

        @field_validator("CORS_ORIGINS", mode="before")
        @classmethod
        def _validate_cors_origins(cls, v: Any) -> List[str]:
            return _parse_str_list(v)

        _env_file = Path(__file__).resolve().parents[1] / ".env"  # backend/.env
        model_config = SettingsConfigDict(
            env_file=str(_env_file),
            env_file_encoding="utf-8",
            case_sensitive=False
        )
    else:
        # Pydantic v1
        from pydantic import validator

        @validator("CORS_ORIGINS", pre=True)
        def _validate_cors_origins(cls, v: Any) -> List[str]:
            return _parse_str_list(v)

        class Config:
            env_file = str(Path(__file__).resolve().parents[1] / ".env")  # backend/.env
            case_sensitive = False


settings = Settings()


_INSECURE_DEFAULTS = {
    "your-secret-key-change-in-production",
    "change-me",
    "secret",
    "",
}


def validate_critical_config():
    """启动时校验关键配置，不合格则立即终止进程（SEC-5b）"""
    errors: list[str] = []

    if settings.SECRET_KEY in _INSECURE_DEFAULTS:
        errors.append(
            "SECRET_KEY 仍为默认值或空值，请在 .env 中设置安全的随机密钥。"
            "生成方法: python3 -c \"import secrets; print(secrets.token_urlsafe(48))\""
        )

    if not settings.REFRESH_SECRET_KEY or settings.REFRESH_SECRET_KEY in _INSECURE_DEFAULTS:
        errors.append(
            "REFRESH_SECRET_KEY 未配置或为默认值，请在 .env 中设置。"
        )

    if settings.SECRET_KEY == settings.REFRESH_SECRET_KEY:
        errors.append(
            "SECRET_KEY 与 REFRESH_SECRET_KEY 不能相同，请分别设置不同的密钥。"
        )

    if errors:
        import sys
        msg = "\n".join(f"  [{i+1}] {e}" for i, e in enumerate(errors))
        print(f"\n{'='*60}")
        print(f"  FATAL: 关键配置校验失败，服务拒绝启动")
        print(f"{'='*60}")
        print(msg)
        print(f"{'='*60}\n")
        sys.exit(1)


