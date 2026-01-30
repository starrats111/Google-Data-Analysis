#!/usr/bin/env python3
"""
验证码识别脚本 - 使用ddddocr库
安装方法: pip install ddddocr
"""

import sys
import ddddocr

def solve_captcha(image_path):
    """识别验证码"""
    try:
        ocr = ddddocr.DdddOcr(show_ad=False)

        with open(image_path, 'rb') as f:
            image_bytes = f.read()

        result = ocr.classification(image_bytes)
        print(result)

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python ocr_solver.py <image_path>")
        sys.exit(1)

    solve_captcha(sys.argv[1])
