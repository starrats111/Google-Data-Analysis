"""
API端点自动检测服务
尝试多个可能的API端点，找到可用的端点
"""
import requests
import logging
from typing import Dict, List, Optional, Tuple
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)


class ApiEndpointDetector:
    """API端点自动检测器"""
    
    # Rewardoo可能的API端点列表
    REWARDOO_POSSIBLE_ENDPOINTS = [
        "https://api.rewardoo.com/api",
        "https://api.rewardoo.com",
        "https://rewardoo.com/api",
        "https://www.rewardoo.com/api",
        "https://www.rewardoo.com/parcelandplate/creator/api",
        "https://www.rewardoo.com/parcelandplate/api",
        "https://api.rewardoo.net/api",
        "https://api.rewardoo.io/api",
    ]
    
    # Rewardoo可能的API路径
    REWARDOO_POSSIBLE_PATHS = [
        "/transaction_details",
        "/transaction",
        "/transactions",
        "/api/transaction_details",
        "/api/transaction",
        "/v1/transaction_details",
        "/v1/transaction",
    ]
    
    # CollabGlow可能的API端点列表
    COLLABGLOW_POSSIBLE_ENDPOINTS = [
        "https://api.collabglow.com/api",
        "https://api.collabglow.com",
        "https://collabglow.com/api",
        "https://www.collabglow.com/api",
        "https://app.collabglow.com/api",
    ]
    
    # CollabGlow可能的API路径（按优先级排序，/transaction优先）
    COLLABGLOW_POSSIBLE_PATHS = [
        "/transaction",  # 优先尝试标准Transaction API
        "/transaction/v3",  # 备选：V3版本
        "/transactions",
        "/api/transaction",
        "/api/transaction/v3",
        "/v3/transaction",
        "/v1/transaction",
        "/commission_validation",
        "/api/commission_validation",
    ]
    
    @staticmethod
    def detect_rewardoo_endpoint(token: str, custom_base_url: Optional[str] = None) -> Optional[Tuple[str, str]]:
        """
        自动检测Rewardoo API端点
        
        Args:
            token: API Token
            custom_base_url: 自定义基础URL（如果提供，优先尝试）
        
        Returns:
            (base_url, endpoint_path) 元组，如果找到可用端点；否则返回None
        """
        # 如果提供了自定义URL，优先尝试
        base_urls_to_try = []
        if custom_base_url:
            base_urls_to_try.append(custom_base_url.rstrip("/"))
        
        # 添加默认的可能端点
        base_urls_to_try.extend(ApiEndpointDetector.REWARDOO_POSSIBLE_ENDPOINTS)
        
        # 准备测试数据
        test_begin_date = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
        test_end_date = datetime.now().strftime("%Y-%m-%d")
        
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}"
        }
        
        # 尝试每个基础URL和路径的组合
        for base_url in base_urls_to_try:
            for path in ApiEndpointDetector.REWARDOO_POSSIBLE_PATHS:
                full_url = f"{base_url}{path}"
                
                # 尝试不同的payload格式
                payloads = [
                    {
                        "token": token,
                        "begin_date": test_begin_date,
                        "end_date": test_end_date
                    },
                    {
                        "token": token,
                        "beginDate": test_begin_date,
                        "endDate": test_end_date
                    },
                    {
                        "api_token": token,
                        "start_date": test_begin_date,
                        "end_date": test_end_date
                    },
                ]
                
                for payload in payloads:
                    try:
                        logger.info(f"[端点检测] 尝试: {full_url}")
                        response = requests.post(
                            full_url,
                            headers=headers,
                            json=payload,
                            timeout=10  # 短超时用于快速检测
                        )
                        
                        # 检查响应
                        if response.status_code == 200:
                            try:
                                result = response.json()
                                # 如果返回的是有效的JSON，且不是错误
                                if isinstance(result, dict) and (
                                    result.get("code") == "0" or 
                                    result.get("code") == 0 or
                                    result.get("success") or
                                    "data" in result or
                                    "transactions" in result
                                ):
                                    logger.info(f"[端点检测] ✓ 找到可用端点: {full_url}")
                                    return (base_url, path)
                            except:
                                pass
                        
                        # 如果是401，说明端点存在但token无效
                        if response.status_code == 401:
                            logger.info(f"[端点检测] ✓ 端点存在但token无效: {full_url}")
                            return (base_url, path)
                        
                    except requests.exceptions.Timeout:
                        continue
                    except requests.exceptions.ConnectionError:
                        continue
                    except Exception as e:
                        logger.debug(f"[端点检测] 端点 {full_url} 不可用: {e}")
                        continue
        
        logger.warning("[端点检测] 未找到可用的Rewardoo API端点")
        return None
    
    @staticmethod
    def detect_collabglow_endpoint(token: str, custom_base_url: Optional[str] = None) -> Optional[Tuple[str, str]]:
        """
        自动检测CollabGlow API端点
        
        Args:
            token: API Token
            custom_base_url: 自定义基础URL（如果提供，优先尝试）
        
        Returns:
            (base_url, endpoint_path) 元组，如果找到可用端点；否则返回None
        """
        # 如果提供了自定义URL，优先尝试
        base_urls_to_try = []
        if custom_base_url:
            base_urls_to_try.append(custom_base_url.rstrip("/"))
        
        # 添加默认的可能端点
        base_urls_to_try.extend(ApiEndpointDetector.COLLABGLOW_POSSIBLE_ENDPOINTS)
        
        # 准备测试数据
        test_begin_date = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
        test_end_date = datetime.now().strftime("%Y-%m-%d")
        
        headers = {
            "Content-Type": "application/json"
        }
        
        # 尝试每个基础URL和路径的组合
        for base_url in base_urls_to_try:
            for path in ApiEndpointDetector.COLLABGLOW_POSSIBLE_PATHS:
                full_url = f"{base_url}{path}"
                
                # 尝试不同的payload格式
                payloads = [
                    {
                        "source": "collabglow",
                        "token": token,
                        "beginDate": test_begin_date,
                        "endDate": test_end_date
                    },
                    {
                        "token": token,
                        "begin_date": test_begin_date,
                        "end_date": test_end_date
                    },
                    {
                        "api_token": token,
                        "start_date": test_begin_date,
                        "end_date": test_end_date
                    },
                ]
                
                for payload in payloads:
                    try:
                        logger.info(f"[端点检测] 尝试CollabGlow: {full_url}")
                        response = requests.post(
                            full_url,
                            headers=headers,
                            json=payload,
                            timeout=10  # 短超时用于快速检测
                        )
                        
                        # 检查响应
                        if response.status_code == 200:
                            try:
                                result = response.json()
                                # 如果返回的是有效的JSON，且不是错误
                                if isinstance(result, dict) and (
                                    result.get("code") == "0" or 
                                    result.get("code") == 0 or
                                    result.get("success") or
                                    "data" in result or
                                    "transactions" in result or
                                    "list" in result
                                ):
                                    logger.info(f"[端点检测] ✓ 找到可用CollabGlow端点: {full_url}")
                                    return (base_url, path)
                            except:
                                pass
                        
                        # 如果是401，说明端点存在但token无效
                        if response.status_code == 401:
                            logger.info(f"[端点检测] ✓ CollabGlow端点存在但token无效: {full_url}")
                            return (base_url, path)
                        
                    except requests.exceptions.Timeout:
                        continue
                    except requests.exceptions.ConnectionError:
                        continue
                    except Exception as e:
                        logger.debug(f"[端点检测] CollabGlow端点 {full_url} 不可用: {e}")
                        continue
        
        logger.warning("[端点检测] 未找到可用的CollabGlow API端点")
        return None
    
    @staticmethod
    def test_endpoint(base_url: str, endpoint_path: str, token: str, method: str = "POST") -> Dict:
        """
        测试API端点是否可用
        
        Args:
            base_url: API基础URL
            endpoint_path: 端点路径
            token: API Token
            method: HTTP方法（GET或POST）
        
        Returns:
            测试结果字典
        """
        full_url = f"{base_url.rstrip('/')}/{endpoint_path.lstrip('/')}"
        
        test_begin_date = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
        test_end_date = datetime.now().strftime("%Y-%m-%d")
        
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}"
        }
        
        payloads = [
            {
                "token": token,
                "begin_date": test_begin_date,
                "end_date": test_end_date
            },
            {
                "token": token,
                "beginDate": test_begin_date,
                "endDate": test_end_date
            },
        ]
        
        for payload in payloads:
            try:
                if method.upper() == "POST":
                    response = requests.post(full_url, headers=headers, json=payload, timeout=10)
                else:
                    response = requests.get(full_url, headers=headers, params=payload, timeout=10)
                
                if response.status_code == 200:
                    try:
                        result = response.json()
                        return {
                            "success": True,
                            "url": full_url,
                            "status_code": response.status_code,
                            "response": result
                        }
                    except:
                        return {
                            "success": False,
                            "url": full_url,
                            "status_code": response.status_code,
                            "error": "响应不是有效的JSON"
                        }
                elif response.status_code == 401:
                    return {
                        "success": True,  # 端点存在，只是token无效
                        "url": full_url,
                        "status_code": response.status_code,
                        "message": "端点存在，但Token无效或已过期"
                    }
                elif response.status_code == 404:
                    continue  # 尝试下一个payload格式
                else:
                    return {
                        "success": False,
                        "url": full_url,
                        "status_code": response.status_code,
                        "error": f"HTTP错误 {response.status_code}: {response.text[:200]}"
                    }
            except requests.exceptions.Timeout:
                continue
            except requests.exceptions.ConnectionError as e:
                return {
                    "success": False,
                    "url": full_url,
                    "error": f"连接错误: {str(e)}"
                }
            except Exception as e:
                continue
        
        return {
            "success": False,
            "url": full_url,
            "error": "所有尝试都失败"
        }

