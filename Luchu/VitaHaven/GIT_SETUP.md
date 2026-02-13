# GitHub推送指南

## 步骤1: 初始化Git仓库（如果还没有）

```bash
cd D:\VitaHaven
git init
```

## 步骤2: 添加远程仓库

```bash
git remote add origin https://github.com/starrats111/VitaHaven.git
```

如果远程仓库已存在，使用以下命令更新：
```bash
git remote set-url origin https://github.com/starrats111/VitaHaven.git
```

## 步骤3: 添加所有文件

```bash
git add .
```

## 步骤4: 提交更改

```bash
git commit -m "Initial commit: VitaHaven lifestyle blog website"
```

## 步骤5: 推送到GitHub

```bash
git branch -M main
git push -u origin main
```

如果遇到认证问题，可能需要：
1. 使用Personal Access Token代替密码
2. 或者使用SSH方式：`git remote set-url origin git@github.com:starrats111/VitaHaven.git`

## 后续更新

以后更新代码时：
```bash
git add .
git commit -m "描述你的更改"
git push
```


