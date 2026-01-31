"""
日志配置
"""
import logging
import sys
from pathlib import Path

# 创建logs目录（使用绝对路径，基于当前文件位置）
_log_config_file = Path(__file__)
_log_dir = _log_config_file.parent.parent / "logs"
_log_dir.mkdir(exist_ok=True)

# 配置日志格式
log_format = logging.Formatter(
    '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)

# 配置根日志记录器
root_logger = logging.getLogger()
root_logger.setLevel(logging.DEBUG)

# 清除现有的处理器
root_logger.handlers.clear()

# 控制台处理器（输出到终端）
console_handler = logging.StreamHandler(sys.stdout)
console_handler.setLevel(logging.INFO)
console_handler.setFormatter(log_format)
root_logger.addHandler(console_handler)

# 文件处理器（输出到文件）
try:
    file_handler = logging.FileHandler(
        _log_dir / "app.log",
        encoding='utf-8'
    )
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(log_format)
    root_logger.addHandler(file_handler)
except Exception as e:
    # 如果文件日志失败，至少保留控制台日志
    print(f"警告: 无法创建文件日志处理器: {e}")

# 错误日志文件（只记录错误）
try:
    error_handler = logging.FileHandler(
        _log_dir / "error.log",
        encoding='utf-8'
    )
error_handler.setLevel(logging.ERROR)
error_handler.setFormatter(log_format)
root_logger.addHandler(error_handler)

# 设置第三方库的日志级别
logging.getLogger("uvicorn").setLevel(logging.INFO)
logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
logging.getLogger("fastapi").setLevel(logging.INFO)









