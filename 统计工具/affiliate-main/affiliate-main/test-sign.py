#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sign函数Python版本 - 用于对比测试
"""

import hashlib

def sign(data, salt="TSf03xGHykY"):
    """计算签名"""
    data = data + salt
    return hashlib.md5(data.encode('utf-8')).hexdigest()

if __name__ == '__main__':
    print('🧪 Sign函数测试 (Python版本)\n')
    print('=' * 60)

    # 测试1: 简单字符串
    test1 = 'hello'
    sign1 = sign(test1)
    print(f'\n测试1: 简单字符串')
    print(f'输入: {test1}')
    print(f'输出: {sign1}')

    # 测试2: 登录参数
    username = 'omnilearn'
    password = 'Ltt.104226'
    code = '1234'
    remember = '1'
    timestamp = '1234567890'

    login_data = username + password + code + remember + timestamp
    sign2 = sign(login_data)

    print(f'\n测试2: 登录参数')
    print(f'输入数据: {login_data}')
    print(f'计算的sign: {sign2}')

    # 测试3: 报表查询参数
    start_date = '2024-12-01'
    end_date = '2024-12-31'
    page = '1'
    page_size = '2000'
    export_flag = '0'

    report_data = f'm_id{start_date}{end_date}{page}{page_size}{export_flag}'
    sign3 = sign(report_data)

    print(f'\n测试3: 报表查询参数')
    print(f'输入数据: {report_data}')
    print(f'计算的sign: {sign3}')

    print('\n' + '=' * 60)
    print('✅ Sign函数测试完成')
