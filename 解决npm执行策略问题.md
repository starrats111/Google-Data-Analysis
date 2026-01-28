# 解决 npm 执行策略问题

## 问题说明

PowerShell 默认禁止运行脚本，导致 `npm` 命令无法执行。

## 解决方案

### 方案1：修改执行策略（推荐）

以管理员身份运行 PowerShell，然后执行：

```powershell
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
```

然后输入 `Y` 确认。

### 方案2：使用 cmd 命令提示符

不使用 PowerShell，改用命令提示符（cmd）：
1. 按 `Win + R`
2. 输入 `cmd`
3. 按回车
4. 在 cmd 中运行 `npm --version`

### 方案3：使用 npm.cmd

在 PowerShell 中，使用完整命令：
```powershell
npm.cmd --version
```

## 推荐操作

使用方案1，一次性解决所有问题。








