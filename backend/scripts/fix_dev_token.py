#!/usr/bin/env python3
"""
修复Developer Token配置
帮助用户检查和设置Developer Token
"""
import sys
import os
from pathlib import Path

# 添加项目根目录到路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import settings

def check_current_config():
    """检查当前配置"""
    print("=" * 80)
    print("当前Developer Token配置状态")
    print("=" * 80)
    
    token = settings.google_ads_shared_developer_token
    has_token = bool(token and token.strip())
    
    print(f"\n配置状态: {'[已配置]' if has_token else '[未配置]'}")
    
    if has_token:
        print(f"Token长度: {len(token)} 字符")
        print(f"Token预览: {token[:20]}...")
        return True, token
    else:
        print("Token值为空或未设置")
        return False, None

def check_env_file():
    """检查.env文件"""
    env_file = Path(__file__).parent.parent / ".env"
    
    print("\n" + "=" * 80)
    print("检查.env文件")
    print("=" * 80)
    
    print(f"\n.env文件路径: {env_file}")
    print(f"文件存在: {env_file.exists()}")
    
    if not env_file.exists():
        print("\n[错误] .env文件不存在")
        return None
    
    # 读取文件内容
    try:
        with open(env_file, 'r', encoding='utf-8') as f:
            content = f.read()
            lines = content.split('\n')
        
        print(f"\n文件总行数: {len(lines)}")
        
        # 查找相关配置
        token_lines = []
        for i, line in enumerate(lines, 1):
            if 'GOOGLE_ADS' in line.upper() or 'DEVELOPER_TOKEN' in line.upper():
                token_lines.append((i, line))
        
        if token_lines:
            print("\n找到相关配置行:")
            for line_num, line in token_lines:
                print(f"  第{line_num}行: {line}")
                
                # 检查是否有值
                if '=' in line:
                    key, value = line.split('=', 1)
                    value = value.strip()
                    if not value:
                        print(f"    [问题] 配置项值为空")
                    elif value.startswith('"') or value.startswith("'"):
                        print(f"    [注意] 值包含引号，可能需要去除")
                    else:
                        print(f"    [正常] 配置项有值 (长度: {len(value)})")
        else:
            print("\n[问题] 未找到GOOGLE_ADS_SHARED_DEVELOPER_TOKEN配置")
        
        return content, lines
        
    except Exception as e:
        print(f"\n[错误] 读取.env文件失败: {e}")
        return None

def update_env_file(token_value):
    """更新.env文件"""
    env_file = Path(__file__).parent.parent / ".env"
    
    print("\n" + "=" * 80)
    print("更新.env文件")
    print("=" * 80)
    
    if not env_file.exists():
        print("\n[信息] .env文件不存在，正在创建...")
        content = "# Google Ads API配置\n"
        content += f"GOOGLE_ADS_SHARED_DEVELOPER_TOKEN={token_value}\n"
        
        with open(env_file, 'w', encoding='utf-8') as f:
            f.write(content)
        print("[完成] 已创建.env文件并设置Developer Token")
        return True
    
    # 读取现有内容
    try:
        with open(env_file, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        # 查找并更新配置
        updated = False
        new_lines = []
        
        for line in lines:
            if line.strip().startswith('GOOGLE_ADS_SHARED_DEVELOPER_TOKEN'):
                # 更新这一行
                new_lines.append(f"GOOGLE_ADS_SHARED_DEVELOPER_TOKEN={token_value}\n")
                updated = True
                print(f"[更新] 找到配置行并更新: {line.strip()}")
            else:
                new_lines.append(line)
        
        if not updated:
            # 如果没有找到，添加到文件末尾
            print("[添加] 未找到配置行，添加到文件末尾")
            new_lines.append(f"\n# Google Ads API配置\n")
            new_lines.append(f"GOOGLE_ADS_SHARED_DEVELOPER_TOKEN={token_value}\n")
        
        # 写入文件
        with open(env_file, 'w', encoding='utf-8') as f:
            f.writelines(new_lines)
        
        print("[完成] .env文件已更新")
        return True
        
    except Exception as e:
        print(f"\n[错误] 更新.env文件失败: {e}")
        return False

def main():
    print("\n" + "=" * 80)
    print("Developer Token配置修复工具")
    print("=" * 80)
    
    # 1. 检查当前配置
    has_token, current_token = check_current_config()
    
    if has_token:
        print("\n[成功] Developer Token已正确配置！")
        print("\n如果仍然遇到问题，可能的原因:")
        print("1. 后端服务未重启（修改.env后需要重启）")
        print("2. Token值不正确或已过期")
        print("3. 其他配置问题")
        return
    
    # 2. 检查.env文件
    env_content = check_env_file()
    
    # 3. 提示用户输入Token
    print("\n" + "=" * 80)
    print("配置Developer Token")
    print("=" * 80)
    
    print("\n请提供你的Google Ads Developer Token:")
    print("(如果不想现在输入，可以直接编辑 .env 文件)")
    print("\n输入方式:")
    print("1. 直接输入Token并按回车")
    print("2. 输入 'skip' 跳过（稍后手动编辑.env文件）")
    
    user_input = input("\n请输入: ").strip()
    
    if user_input.lower() == 'skip':
        print("\n[跳过] 请稍后手动编辑 .env 文件")
        print(f"文件路径: {Path(__file__).parent.parent / '.env'}")
        print("配置项: GOOGLE_ADS_SHARED_DEVELOPER_TOKEN=你的Token")
        return
    
    if not user_input:
        print("\n[错误] Token不能为空")
        return
    
    # 去除可能的引号
    token_value = user_input.strip('"').strip("'").strip()
    
    if not token_value:
        print("\n[错误] Token值无效")
        return
    
    # 4. 更新.env文件
    if update_env_file(token_value):
        print("\n" + "=" * 80)
        print("配置完成")
        print("=" * 80)
        print("\n[重要] 请执行以下步骤:")
        print("1. 重启后端服务以使配置生效")
        print("2. 运行以下命令验证配置:")
        print("   python scripts/check_dev_token.py")
        print("\n如果配置后仍然检测不到，请检查:")
        print("1. .env文件位置是否正确 (backend/.env)")
        print("2. 配置项名称是否正确 (GOOGLE_ADS_SHARED_DEVELOPER_TOKEN)")
        print("3. Token值是否正确（没有多余的空格或引号）")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n[取消] 操作已取消")
    except Exception as e:
        print(f"\n[错误] {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)












