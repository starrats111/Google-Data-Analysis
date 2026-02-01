# 安装命令 - 直接复制粘贴

## ⚠️ 重要：使用旧版本避免编译问题

我已经更新了所有版本，使用完全预编译的版本，不需要 Rust 编译器。

---

## 📋 后端安装命令（按顺序执行）

### 在 PowerShell 中，一个命令一个命令复制粘贴：

```powershell
cd "D:\Google Analysis\backend"
```

```powershell
python -m venv venv
```

```powershell
.\venv\Scripts\Activate.ps1
```

```powershell
python -m pip install --upgrade pip
```

```powershell
pip install fastapi==0.95.2
```

```powershell
pip install uvicorn==0.22.0
```

```powershell
pip install sqlalchemy==1.4.46
```

```powershell
pip install pydantic==1.10.12
```

```powershell
pip install python-jose
```

```powershell
pip install passlib
```

```powershell
pip install python-multipart
```

```powershell
pip install openpyxl
```

```powershell
pip install python-dotenv
```

```powershell
python scripts/init_db.py
```

```powershell
python scripts/init_users.py
```

```powershell
python scripts/init_platforms.py
```

```powershell
uvicorn app.main:app --reload
```

---

## 📋 前端安装命令（在新的 PowerShell 窗口）

```powershell
cd "D:\Google Analysis\frontend"
```

```powershell
npm install
```

```powershell
npm run dev
```

---

## ✅ 验证

1. 后端：http://localhost:8000/docs
2. 前端：http://localhost:3000
3. 登录：manager / manager123

---

## 💡 提示

- **每个命令单独执行**，等待完成后再执行下一个
- **后端和前端需要在不同的窗口运行**
- **保持两个窗口都打开**

















