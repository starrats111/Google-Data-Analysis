# 将 BloomRoots 推送到 GitHub 的步骤

## 前提条件
确保已安装 Git。如果未安装，请访问：https://git-scm.com/download/win

## 推送步骤

### 1. 打开终端/命令提示符
在项目目录 `D:\BloomRoots` 中打开 PowerShell 或命令提示符。

### 2. 初始化 Git 仓库（如果尚未初始化）
```bash
git init
```

### 3. 添加所有文件到暂存区
```bash
git add .
```

### 4. 创建初始提交
```bash
git commit -m "Initial commit: BloomRoots lifestyle blog website"
```

### 5. 添加远程仓库
```bash
git remote add origin https://github.com/starrats111/BloomRoots.git
```

### 6. 设置主分支（如果需要）
```bash
git branch -M main
```

### 7. 推送到 GitHub
```bash
git push -u origin main
```

## 如果遇到问题

### 如果远程仓库已存在
如果远程仓库已经有内容，可能需要先拉取：
```bash
git pull origin main --allow-unrelated-histories
```
然后再推送：
```bash
git push -u origin main
```

### 如果需要身份验证
GitHub 现在要求使用个人访问令牌（Personal Access Token）而不是密码。

1. 访问：https://github.com/settings/tokens
2. 生成新的 token（选择 `repo` 权限）
3. 推送时使用 token 作为密码

### 如果遇到权限问题
确保你有该仓库的写入权限。如果没有，需要：
1. 在 GitHub 上确认仓库地址正确
2. 确认你的 GitHub 账户有权限访问该仓库

## 后续更新代码

以后如果需要更新代码到 GitHub：

```bash
git add .
git commit -m "描述你的更改"
git push
```




