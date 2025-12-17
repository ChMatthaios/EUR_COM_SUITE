# backend/auth_utils.py
"""
Auth utilities:
- Password hashing: Argon2 (good modern default)
- JWT creation/verification: PyJWT

This file is intentionally small and dependency-free beyond argon2 + pyjwt.
"""

import os
import time
import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

# Argon2 has sane defaults; tune later if needed (memory_cost, time_cost, parallelism).
ph = PasswordHasher()

JWT_SECRET = os.getenv("EURCOM_JWT_SECRET", "dev-secret-change-me")
JWT_ALG = os.getenv("EURCOM_JWT_ALG", "HS256")
JWT_EXP_MIN = int(os.getenv("EURCOM_JWT_EXP_MIN", "60"))


def hash_password(password: str) -> str:
    """Hash a plaintext password using Argon2."""
    if password is None:
        raise ValueError("password cannot be None")
    return ph.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    """Verify a plaintext password against an Argon2 hash."""
    try:
        return ph.verify(password_hash, password)
    except VerifyMismatchError:
        return False
    except Exception:
        # Defensive: if the stored hash is malformed/corrupted
        return False


def create_access_token(sub: str, role: str, user_id: int) -> str:
    """
    Create a JWT token.

    Claims:
      sub: username
      role: CUSTOMER/EMPLOYEE/ADMIN
      uid: numeric user id
      iat/exp: issued-at + expiry (seconds)
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
    """Decode/verify a JWT token (raises if invalid/expired)."""
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
