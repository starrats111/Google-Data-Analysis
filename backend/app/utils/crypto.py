"""
AES-256-CBC token 加解密工具（OPT-009）
密钥从环境变量 TOKEN_ENCRYPT_KEY 读取。
"""
import base64
import hashlib
import os

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import padding as sym_padding
from cryptography.hazmat.backends import default_backend

_BLOCK = 16  # AES block size


def _derive_key() -> bytes:
    from app.config import settings
    raw = getattr(settings, "TOKEN_ENCRYPT_KEY", "") or ""
    if not raw:
        raw = "default-insecure-key-change-me"
    return hashlib.sha256(raw.encode()).digest()


def encrypt_token(plaintext: str) -> str:
    key = _derive_key()
    iv = os.urandom(_BLOCK)
    padder = sym_padding.PKCS7(_BLOCK * 8).padder()
    padded = padder.update(plaintext.encode()) + padder.finalize()
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
    encryptor = cipher.encryptor()
    ct = encryptor.update(padded) + encryptor.finalize()
    return base64.b64encode(iv + ct).decode()


def decrypt_token(ciphertext: str) -> str:
    key = _derive_key()
    raw = base64.b64decode(ciphertext)
    iv, ct = raw[:_BLOCK], raw[_BLOCK:]
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv), backend=default_backend())
    decryptor = cipher.decryptor()
    padded = decryptor.update(ct) + decryptor.finalize()
    unpadder = sym_padding.PKCS7(_BLOCK * 8).unpadder()
    return (unpadder.update(padded) + unpadder.finalize()).decode()
