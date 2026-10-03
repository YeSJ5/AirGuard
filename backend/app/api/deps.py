from typing import Optional
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import jwt, JWTError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.config import settings
from app.core.database import get_db
from app.models import User

reusable_oauth2 = OAuth2PasswordBearer(
    tokenUrl=f"{settings.API_V1_STR}/auth/login"
)

async def get_current_user(
    db: AsyncSession = Depends(get_db),
    token: str = Depends(reusable_oauth2)
) -> User:
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        token_data_sub = payload.get("sub")
        if token_data_sub is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Could not validate credentials",
            )
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
        )
    
    user_cache_key = f"cache:user:{token_data_sub}"
    try:
        from app.core.redis import redis_client
        import json
        cached_user = await redis_client.get(user_cache_key)
        if cached_user:
            data = json.loads(cached_user)
            return User(id=data["id"], email=data["email"], role=data["role"])
    except Exception:
        pass
    
    if str(token_data_sub).isdigit():
        result = await db.execute(select(User).where(User.id == int(token_data_sub)))
    else:
        result = await db.execute(select(User).where(User.email == str(token_data_sub).lower()))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )
    try:
        await redis_client.setex(
            user_cache_key,
            60,
            json.dumps({"id": user.id, "email": user.email, "role": user.role})
        )
    except Exception:
        pass
    return user


async def get_websocket_user(
    db: AsyncSession,
    token: str
) -> Optional[User]:
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        token_data_sub = payload.get("sub")
        if token_data_sub is None:
            return None
        if str(token_data_sub).isdigit():
            result = await db.execute(select(User).where(User.id == int(token_data_sub)))
        else:
            result = await db.execute(select(User).where(User.email == str(token_data_sub).lower()))
        return result.scalar_one_or_none()
    except Exception:
        return None


class RoleChecker:
    def __init__(self, allowed_roles: list[str]):
        self.allowed_roles = allowed_roles

    def __call__(self, current_user: User = Depends(get_current_user)) -> User:
        if current_user.role not in self.allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="The user does not have enough privileges"
            )
        return current_user


# Role dependency instances
require_viewer = RoleChecker(["viewer", "analyst", "admin"])
require_analyst = RoleChecker(["analyst", "admin"])
require_admin = RoleChecker(["admin"])
