"""
应用配置
"""
try:
    from pydantic_settings import BaseSettings, SettingsConfigDict
except ImportError:
    # 兼容 pydantic 1.x
    from pydantic import BaseSettings
    SettingsConfigDict = None
from typing import Set


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
    CORS_ORIGINS: list = ["http://localhost:3000", "http://localhost:8000"]

    # 汇率配置
    # 用于当谷歌广告表1为人民币(CNY/RMB)时，将费用/CPC等换算为美元(USD)
    # 含义：1 USD = CNY_TO_USD_RATE CNY，因此 CNY -> USD 需要除以该值
    CNY_TO_USD_RATE: float = 7.2
    
    if SettingsConfigDict is not None:
        # Pydantic v2
        model_config = SettingsConfigDict(
            env_file=".env",
            case_sensitive=False
        )
    else:
        # Pydantic v1
        class Config:
            env_file = ".env"
            case_sensitive = False


settings = Settings()


