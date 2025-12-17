"""
Auth utilities:
- Argon2 password hashing (safe on Windows, avoids bcrypt quirks)
- JWT creation + decoding
"""

import os
import time
import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

# Argon2 hasher (good default parameters)
ph = PasswordHasher()

# JWT settings from environment
JWT_SECRET = os.getenv("EURCOM_JWT_SECRET", "dev-secret-change-me")
JWT_ALG = os.getenv("EURCOM_JWT_ALG", "HS256")
JWT_EXP_MIN = int(os.getenv("EURCOM_JWT_EXP_MIN", "60"))


def hash_password(password: str) -> str:
    """Hash a plaintext password for storage."""
    return ph.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    """Verify a plaintext password against a stored Argon2 hash."""
    try:
        return ph.verify(password_hash, password)
    except VerifyMismatchError:
        return False


def create_access_token(sub: str, role: str, user_id: int) -> str:
    """
    Create a JWT access token.
    Claims:
      sub: username
      role: role string
      uid: user id
      iat/exp: issued-at / expiry
    """
    now = int(time.time())
    payload = {
        "sub": sub,
        "role": role,
        "uid": user_id,
        "iat": now,
        "exp": now + JWT_EXP_MIN * 60,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def decode_token(token: str) -> dict:
    """Decode and validate a JWT token."""
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
