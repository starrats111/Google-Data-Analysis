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
    # 数据库配置
    DATABASE_URL: str = "sqlite:///./google_analysis.db"
    
    # JWT配置
    SECRET_KEY: str = "your-secret-key-change-in-production"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 1440  # 24小时
    
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
    MANAGER_USERNAME: str = "wenjun123"
    EMPLOYEE_COUNT: int = 10
    
    # CORS配置
    CORS_ORIGINS: List[str] = [
        # Local dev (Vite/React)
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        # Local API
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "https://google-data-analysis.top",
        # Cloudflare Pages production domain
        "https://google-data-analysis.pages.dev",
    ]

    # 汇率配置
    # 用于当谷歌广告表1为人民币(CNY/RMB)时，将费用/CPC等换算为美元(USD)
    # 含义：1 USD = CNY_TO_USD_RATE CNY，因此 CNY -> USD 需要除以该值
    CNY_TO_USD_RATE: float = 7.2

    # ===== AI 点评（可选）=====
    # 若不配置 OPENAI_API_KEY，则系统自动使用规则版点评（不影响功能）
    OPENAI_API_KEY: str = ""
    OPENAI_MODEL: str = "gpt-4o-mini"
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


