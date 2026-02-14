"""
日志配置

功能:
- 结构化 JSON 日志格式（便于日志分析）
- 分级日志文件（app.log, error.log）
- 日志轮转（避免文件过大）
- 请求 ID 追踪
"""
import logging
import logging.handlers
import sys
import json
from pathlib import Path
from datetime import datetime
from typing import Optional

# 创建logs目录（使用绝对路径，基于当前文件位置）
_log_config_file = Path(__file__)
_log_dir = _log_config_file.parent.parent / "logs"
_log_dir.mkdir(exist_ok=True)


class StructuredFormatter(logging.Formatter):
    """结构化 JSON 日志格式化器
    
    输出格式:
    {
        "timestamp": "2024-01-15T10:30:15.123Z",
        "level": "INFO",
        "logger": "app.api.luchu_images",
        "message": "Image proxy success",
        "extra": { ... }  # 可选的额外字段
    }
    """
    
    def format(self, record: logging.LogRecord) -> str:
        log_data = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        
        # 添加文件位置信息（仅在 DEBUG 模式）
        if record.levelno <= logging.DEBUG:
            log_data["location"] = f"{record.filename}:{record.lineno}"
        
        # 添加异常信息
        if record.exc_info:
            log_data["exception"] = self.formatException(record.exc_info)
        
        # 添加额外字段（通过 extra 参数传入）
        extra_fields = {}
        for key, value in record.__dict__.items():
            if key not in [
                'name', 'msg', 'args', 'created', 'filename', 'funcName',
                'levelname', 'levelno', 'lineno', 'module', 'msecs',
                'pathname', 'process', 'processName', 'relativeCreated',
                'stack_info', 'exc_info', 'exc_text', 'thread', 'threadName',
                'message', 'asctime'
            ]:
                try:
                    # 确保值可以被 JSON 序列化
                    json.dumps(value)
                    extra_fields[key] = value
                except (TypeError, ValueError):
                    extra_fields[key] = str(value)
        
        if extra_fields:
            log_data["extra"] = extra_fields
        
        return json.dumps(log_data, ensure_ascii=False)


class ReadableFormatter(logging.Formatter):
    """人类可读的日志格式化器（用于控制台）"""
    
    COLORS = {
        'DEBUG': '\033[36m',     # Cyan
        'INFO': '\033[32m',      # Green
        'WARNING': '\033[33m',   # Yellow
        'ERROR': '\033[31m',     # Red
        'CRITICAL': '\033[35m',  # Magenta
    }
    RESET = '\033[0m'
    
    def format(self, record: logging.LogRecord) -> str:
        # 时间戳
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        
        # 级别颜色
        color = self.COLORS.get(record.levelname, '')
        reset = self.RESET if color else ''
        
        # 简化的 logger 名称
        logger_name = record.name
        if logger_name.startswith('app.'):
            logger_name = logger_name[4:]
        
        # 格式化消息
        message = record.getMessage()
        
        # 基本格式
        formatted = f"{timestamp} {color}{record.levelname:8}{reset} [{logger_name}] {message}"
        
        # 添加异常信息
        if record.exc_info:
            formatted += f"\n{self.formatException(record.exc_info)}"
        
        return formatted


def get_structured_logger(name: str) -> logging.Logger:
    """获取结构化日志记录器
    
    使用方法:
        logger = get_structured_logger(__name__)
        logger.info("Image proxy success", extra={
            "url": "https://example.com/img.jpg",
            "duration_ms": 245,
            "cache_hit": True
        })
    """
    return logging.getLogger(name)


# 配置根日志记录器
root_logger = logging.getLogger()
root_logger.setLevel(logging.DEBUG)

# 清除现有的处理器
root_logger.handlers.clear()

# 控制台处理器（人类可读格式）
console_handler = logging.StreamHandler(sys.stdout)
console_handler.setLevel(logging.INFO)
console_handler.setFormatter(ReadableFormatter())
root_logger.addHandler(console_handler)

# 文件处理器（JSON 格式，带轮转）
try:
    # 主日志文件：最大 10MB，保留 5 个备份
    file_handler = logging.handlers.RotatingFileHandler(
        _log_dir / "app.log",
        maxBytes=10 * 1024 * 1024,  # 10MB
        backupCount=5,
        encoding='utf-8'
    )
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(StructuredFormatter())
    root_logger.addHandler(file_handler)
except Exception as e:
    print(f"警告: 无法创建文件日志处理器: {e}")

# 错误日志文件（JSON 格式，只记录 WARNING 及以上）
try:
    error_handler = logging.handlers.RotatingFileHandler(
        _log_dir / "error.log",
        maxBytes=10 * 1024 * 1024,  # 10MB
        backupCount=5,
        encoding='utf-8'
    )
    error_handler.setLevel(logging.WARNING)
    error_handler.setFormatter(StructuredFormatter())
    root_logger.addHandler(error_handler)
except Exception as e:
    print(f"警告: 无法创建错误日志处理器: {e}")

# 设置第三方库的日志级别（减少噪音）
logging.getLogger("uvicorn").setLevel(logging.INFO)
logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
logging.getLogger("uvicorn.error").setLevel(logging.INFO)
logging.getLogger("fastapi").setLevel(logging.INFO)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("playwright").setLevel(logging.WARNING)
logging.getLogger("sqlalchemy").setLevel(logging.WARNING)


# 告警辅助函数
class AlertLevel:
    """告警级别常量"""
    P0_CRITICAL = "P0"  # 致命：服务宕机
    P1_URGENT = "P1"    # 紧急：功能异常
    P2_WARNING = "P2"   # 警告：需要关注


def log_alert(
    logger: logging.Logger,
    level: str,
    title: str,
    message: str,
    context: Optional[dict] = None,
    suggested_actions: Optional[list] = None
):
    """记录告警日志
    
    Args:
        logger: 日志记录器
        level: 告警级别 (P0/P1/P2)
        title: 告警标题
        message: 告警详情
        context: 上下文信息（问题定位）
        suggested_actions: 建议操作
    
    Example:
        log_alert(
            logger,
            AlertLevel.P1_URGENT,
            "图片代理成功率下降",
            "过去5分钟成功率为65%，低于阈值70%",
            context={
                "success_rate": 0.65,
                "failed_domain": "img.dianping.com",
                "error_type": "TimeoutError"
            },
            suggested_actions=[
                "检查目标网站是否正常",
                "查看熔断状态",
                "手动重置熔断"
            ]
        )
    """
    extra = {
        "alert_level": level,
        "alert_title": title,
    }
    
    if context:
        extra["context"] = context
    
    if suggested_actions:
        extra["suggested_actions"] = suggested_actions
    
    # 根据告警级别选择日志级别
    if level == AlertLevel.P0_CRITICAL:
        logger.critical(f"[{level}] {title}: {message}", extra=extra)
    elif level == AlertLevel.P1_URGENT:
        logger.error(f"[{level}] {title}: {message}", extra=extra)
    else:
        logger.warning(f"[{level}] {title}: {message}", extra=extra)
