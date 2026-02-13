"""
GitHub API 服务 - 用于发布文章到博客网站仓库
"""
import httpx
import json
import base64
import logging
from typing import Dict, Any, Optional, List
from datetime import datetime

logger = logging.getLogger(__name__)


class GitHubService:
    """GitHub API 服务"""
    
    def __init__(self, token: str):
        self.token = token
        self.base_url = "https://api.github.com"
        self.headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github.v3+json",
            "X-GitHub-Api-Version": "2022-11-28"
        }
    
    async def publish_article(
        self,
        repo: str,
        article_id: int,
        article_data: Dict[str, Any],
        data_path: str = "js/articles",
        commit_message: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        发布文章到 GitHub 仓库
        
        Args:
            repo: 仓库名称 (owner/repo 格式，如 starrats111/VitaHaven)
            article_id: 文章ID
            article_data: 文章数据（JSON格式）
            data_path: 数据存放路径
            commit_message: 提交信息
            
        Returns:
            发布结果，包含 commit_sha 和 file_path
        """
        logger.info(f"[GitHub] 发布文章到 {repo}: ID={article_id}")
        
        file_path = f"{data_path}/{article_id}.json"
        content = json.dumps(article_data, ensure_ascii=False, indent=2)
        
        if not commit_message:
            commit_message = f"新增文章: {article_data.get('title', f'Article {article_id}')}"
        
        try:
            # 检查文件是否存在（获取 SHA）
            existing_sha = await self._get_file_sha(repo, file_path)
            
            # 创建或更新文件
            result = await self._create_or_update_file(
                repo=repo,
                path=file_path,
                content=content,
                message=commit_message,
                sha=existing_sha
            )
            
            # 更新文章索引
            await self._update_article_index(repo, article_id, article_data, data_path)
            
            logger.info(f"[GitHub] 发布成功: {result.get('commit', {}).get('sha', '')[:7]}")
            
            return {
                "success": True,
                "commit_sha": result.get("commit", {}).get("sha", ""),
                "file_path": file_path,
                "html_url": result.get("content", {}).get("html_url", "")
            }
            
        except Exception as e:
            logger.error(f"[GitHub] 发布失败: {e}")
            return {
                "success": False,
                "error": str(e)
            }
    
    async def get_article_template(self, repo: str) -> Optional[str]:
        """
        获取目标网站的文章模板（用于真实预览）
        
        Args:
            repo: 仓库名称
            
        Returns:
            article.html 模板内容
        """
        try:
            content = await self._get_file_content(repo, "article.html")
            return content
        except Exception as e:
            logger.warning(f"[GitHub] 获取模板失败: {e}")
            return None
    
    async def _get_file_sha(self, repo: str, path: str) -> Optional[str]:
        """获取文件的 SHA（用于更新）"""
        url = f"{self.base_url}/repos/{repo}/contents/{path}"
        
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(url, headers=self.headers)
                if response.status_code == 200:
                    return response.json().get("sha")
                return None
        except Exception:
            return None
    
    async def _get_file_content(self, repo: str, path: str) -> str:
        """获取文件内容"""
        url = f"{self.base_url}/repos/{repo}/contents/{path}"
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(url, headers=self.headers)
            response.raise_for_status()
            data = response.json()
            content = base64.b64decode(data["content"]).decode("utf-8")
            return content
    
    async def _create_or_update_file(
        self,
        repo: str,
        path: str,
        content: str,
        message: str,
        sha: Optional[str] = None
    ) -> Dict[str, Any]:
        """创建或更新文件"""
        url = f"{self.base_url}/repos/{repo}/contents/{path}"
        
        data = {
            "message": message,
            "content": base64.b64encode(content.encode("utf-8")).decode("utf-8")
        }
        
        if sha:
            data["sha"] = sha
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.put(url, headers=self.headers, json=data)
            response.raise_for_status()
            return response.json()
    
    async def _update_article_index(
        self,
        repo: str,
        article_id: int,
        article_data: Dict[str, Any],
        data_path: str
    ) -> None:
        """更新文章索引文件"""
        index_path = f"{data_path}-index.js"
        
        try:
            # 获取现有索引
            existing_content = await self._get_file_content(repo, index_path)
            existing_sha = await self._get_file_sha(repo, index_path)
            
            # 解析现有索引
            # 格式: const articlesIndex = [...];
            import re
            match = re.search(r'const\s+articlesIndex\s*=\s*(\[[\s\S]*?\]);', existing_content)
            if match:
                index_data = json.loads(match.group(1))
            else:
                index_data = []
            
        except Exception:
            index_data = []
            existing_sha = None
        
        # 构建索引条目
        index_entry = {
            "id": article_id,
            "title": article_data.get("title", ""),
            "slug": article_data.get("slug", f"article-{article_id}"),
            "category": article_data.get("category", ""),
            "categoryName": article_data.get("categoryName", ""),
            "excerpt": article_data.get("excerpt", ""),
            "date": article_data.get("date", datetime.now().strftime("%Y-%m-%d")),
            "image": article_data.get("images", {}).get("hero", {}).get("url", "")
        }
        
        # 更新或添加条目
        found = False
        for i, item in enumerate(index_data):
            if item.get("id") == article_id:
                index_data[i] = index_entry
                found = True
                break
        
        if not found:
            index_data.insert(0, index_entry)  # 新文章放在最前面
        
        # 生成新的索引内容
        new_content = f"const articlesIndex = {json.dumps(index_data, ensure_ascii=False, indent=2)};\n"
        
        # 更新索引文件
        await self._create_or_update_file(
            repo=repo,
            path=index_path,
            content=new_content,
            message=f"更新文章索引: {article_data.get('title', f'Article {article_id}')}",
            sha=existing_sha
        )
    
    async def check_image_url(self, url: str) -> Dict[str, Any]:
        """检查图片URL是否有效"""
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.head(url, follow_redirects=True)
                return {
                    "url": url,
                    "valid": response.is_success,
                    "status_code": response.status_code,
                    "content_type": response.headers.get("content-type", "")
                }
        except Exception as e:
            return {
                "url": url,
                "valid": False,
                "error": str(e)
            }
    
    async def download_image_to_repo(
        self,
        repo: str,
        image_url: str,
        target_path: str
    ) -> Dict[str, Any]:
        """下载图片到仓库（本地化）"""
        try:
            # 下载图片
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(image_url, follow_redirects=True)
                response.raise_for_status()
                image_content = response.content
            
            # 上传到仓库
            url = f"{self.base_url}/repos/{repo}/contents/{target_path}"
            
            data = {
                "message": f"添加图片: {target_path}",
                "content": base64.b64encode(image_content).decode("utf-8")
            }
            
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.put(url, headers=self.headers, json=data)
                response.raise_for_status()
                result = response.json()
            
            return {
                "success": True,
                "path": target_path,
                "url": result.get("content", {}).get("download_url", "")
            }
            
        except Exception as e:
            logger.error(f"[GitHub] 图片下载失败: {e}")
            return {
                "success": False,
                "error": str(e)
            }


# 单例实例（延迟初始化）
_github_service: Optional[GitHubService] = None


def get_github_service(token: str = None) -> GitHubService:
    """获取 GitHub 服务实例"""
    global _github_service
    
    if _github_service is None:
        if token is None:
            from app.config import settings
            token = getattr(settings, 'GITHUB_TOKEN', None)
            if not token:
                raise ValueError("GITHUB_TOKEN 未配置")
        _github_service = GitHubService(token)
    
    return _github_service

