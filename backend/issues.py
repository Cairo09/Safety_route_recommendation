import random
import string
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from backend.auth import get_current_user
from backend.database import get_db
from backend.models import Issue, User, Validation

router = APIRouter(prefix="/issues", tags=["issues"])

VALID_CATEGORIES = [
    "Broken Streetlight",
    "Pothole",
    "Narrow Lane",
    "Unsafe Area",
    "Other",
]


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

class IssueCreate(BaseModel):
    lat: float
    lon: float
    category: str
    description: Optional[str] = ""

    @field_validator("lat")
    @classmethod
    def validate_lat(cls, v: float) -> float:
        if not (-90 <= v <= 90):
            raise ValueError("lat must be between -90 and 90")
        return v

    @field_validator("lon")
    @classmethod
    def validate_lon(cls, v: float) -> float:
        if not (-180 <= v <= 180):
            raise ValueError("lon must be between -180 and 180")
        return v

    @field_validator("category")
    @classmethod
    def validate_category(cls, v: str) -> str:
        if v not in VALID_CATEGORIES:
            raise ValueError(f"category must be one of {VALID_CATEGORIES}")
        return v


class ValidateRequest(BaseModel):
    response: str  # "confirm" or "dismiss"

    @field_validator("response")
    @classmethod
    def validate_response(cls, v: str) -> str:
        if v not in ("confirm", "dismiss"):
            raise ValueError("response must be 'confirm' or 'dismiss'")
        return v


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _generate_id(length: int = 8) -> str:
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=length))


def _compute_confidence(num_reports: int, num_confirmations: int, num_dismissals: int) -> float:
    score = 50 + 15 * num_reports + 10 * num_confirmations - 8 * num_dismissals
    return float(max(0, min(100, score)))


_SPAM_RADIUS_DEG  = 0.0009   # ~100 m at Bangalore latitude
_SPAM_WINDOW_H    = 6        # hours — same user, same area
_DAILY_LIMIT      = 5        # max new issues per user per 24 h
_AUTO_EXPIRE_DAYS = 30
_AUTO_EXPIRE_MIN_EFFECTIVE_CONF = 20.0
_DEDUP_RADIUS_DEG = 0.0003   # ~30 m — aggregate same-category reports near same spot


def _check_spam(db: Session, user: "User", lat: float, lon: float) -> None:
    """Raise 429 if the user is spamming reports."""
    now = datetime.now(timezone.utc)

    # 1. Same user, any location — 5 reports in last 24 hours
    cutoff_day = now - timedelta(hours=24)
    recent_total = (
        db.query(Issue)
        .filter(
            Issue.reporter_id == user.id,
            Issue.reported_at >= cutoff_day,
        )
        .count()
    )
    if recent_total >= _DAILY_LIMIT:
        raise HTTPException(
            status_code=429,
            detail=f"Daily limit reached. You can report at most {_DAILY_LIMIT} issues per 24 hours.",
        )

    # 2. Same user, within ~100 m bounding box, within last 6 hours
    cutoff_area = now - timedelta(hours=_SPAM_WINDOW_H)
    nearby = (
        db.query(Issue)
        .filter(
            Issue.reporter_id == user.id,
            Issue.reported_at >= cutoff_area,
            Issue.lat >= lat - _SPAM_RADIUS_DEG,
            Issue.lat <= lat + _SPAM_RADIUS_DEG,
            Issue.lon >= lon - _SPAM_RADIUS_DEG,
            Issue.lon <= lon + _SPAM_RADIUS_DEG,
        )
        .first()
    )
    if nearby:
        raise HTTPException(
            status_code=429,
            detail="You already reported an issue in this area recently. Wait 6 hours before reporting again.",
        )


def _issue_to_dict(issue: Issue) -> dict:
    return {
        "id": issue.id,
        "lat": issue.lat,
        "lon": issue.lon,
        "category": issue.category,
        "description": issue.description,
        "reporter_name": issue.reporter_name,
        "confidence_score": issue.confidence_score,
        "effective_confidence": issue.effective_confidence,
        "num_reports": issue.num_reports,
        "num_confirmations": issue.num_confirmations,
        "num_dismissals": issue.num_dismissals,
        "is_active": issue.is_active,
        "reported_at": issue.reported_at.isoformat() if issue.reported_at else None,
        "last_validated": issue.last_validated.isoformat() if issue.last_validated else None,
        "needs_revalidation": issue.needs_revalidation,
    }


def deactivate_stale_issues(db: Session) -> int:
    """
    Auto-deactivate issues that are likely resolved/noisy:
    - no confirmations ever
    - older than AUTO_EXPIRE_DAYS
    - effective confidence has decayed below threshold
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=_AUTO_EXPIRE_DAYS)
    candidates = (
        db.query(Issue)
        .filter(
            Issue.is_active == True,
            Issue.num_confirmations == 0,
            Issue.reported_at <= cutoff,
        )
        .all()
    )
    changed = 0
    for issue in candidates:
        if issue.effective_confidence < _AUTO_EXPIRE_MIN_EFFECTIVE_CONF:
            issue.is_active = False
            changed += 1
    if changed:
        db.commit()
    return changed


# ---------------------------------------------------------------------------
# Endpoints — ordering matters: specific paths before parameterised ones
# ---------------------------------------------------------------------------

@router.get("/stats/summary")
def get_stats_summary(db: Session = Depends(get_db)):
    """Return aggregate statistics across all active issues."""
    total = db.query(Issue).filter(Issue.is_active == True).count()
    by_category: dict = {}
    for cat in VALID_CATEGORIES:
        by_category[cat] = db.query(Issue).filter(
            Issue.is_active == True, Issue.category == cat
        ).count()

    avg_confidence_row = (
        db.query(Issue.confidence_score)
        .filter(Issue.is_active == True)
        .all()
    )
    if avg_confidence_row:
        avg_conf = sum(r[0] for r in avg_confidence_row) / len(avg_confidence_row)
    else:
        avg_conf = 0.0

    return {
        "total_active": total,
        "by_category": by_category,
        "avg_confidence": round(avg_conf, 1),
    }


@router.post("", status_code=status.HTTP_201_CREATED)
def create_issue(
    body: IssueCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Reject spam before touching the DB
    _check_spam(db, current_user, body.lat, body.lon)

    # Deduplication: if same category already reported within ~30 m, aggregate instead of creating new marker
    existing_nearby = (
        db.query(Issue)
        .filter(
            Issue.is_active == True,
            Issue.category == body.category,
            Issue.lat >= body.lat - _DEDUP_RADIUS_DEG,
            Issue.lat <= body.lat + _DEDUP_RADIUS_DEG,
            Issue.lon >= body.lon - _DEDUP_RADIUS_DEG,
            Issue.lon <= body.lon + _DEDUP_RADIUS_DEG,
        )
        .first()
    )
    if existing_nearby:
        existing_nearby.num_reports += 1
        existing_nearby.confidence_score = _compute_confidence(
            existing_nearby.num_reports, existing_nearby.num_confirmations, existing_nearby.num_dismissals
        )
        db.commit()
        db.refresh(existing_nearby)
        return _issue_to_dict(existing_nearby)

    issue_id = _generate_id()
    # Ensure uniqueness
    while db.query(Issue).filter(Issue.id == issue_id).first():
        issue_id = _generate_id()

    confidence = _compute_confidence(1, 0, 0)
    issue = Issue(
        id=issue_id,
        lat=body.lat,
        lon=body.lon,
        category=body.category,
        description=body.description or "",
        reporter_id=current_user.id,
        reporter_name=current_user.username,
        confidence_score=confidence,
        num_reports=1,
        num_confirmations=0,
        num_dismissals=0,
        is_active=True,
        reported_at=datetime.now(timezone.utc),
    )
    db.add(issue)
    db.commit()
    db.refresh(issue)
    return _issue_to_dict(issue)


@router.get("/heatmap")
def get_issue_heatmap(
    lat_min: Optional[float] = None,
    lat_max: Optional[float] = None,
    lon_min: Optional[float] = None,
    lon_max: Optional[float] = None,
    cell_size: float = 0.005,
    db: Session = Depends(get_db),
):
    """
    Return issue-density grid as GeoJSON polygons.
    cell_size in degrees; 0.005 is roughly ~550m in latitude.
    """
    if cell_size <= 0 or cell_size > 0.05:
        raise HTTPException(status_code=400, detail="cell_size must be between 0 and 0.05")

    q = db.query(Issue).filter(Issue.is_active == True)
    if lat_min is not None:
        q = q.filter(Issue.lat >= lat_min)
    if lat_max is not None:
        q = q.filter(Issue.lat <= lat_max)
    if lon_min is not None:
        q = q.filter(Issue.lon >= lon_min)
    if lon_max is not None:
        q = q.filter(Issue.lon <= lon_max)

    issues = q.all()
    buckets: dict = {}
    for issue in issues:
        lat_idx = int(issue.lat // cell_size)
        lon_idx = int(issue.lon // cell_size)
        key = (lat_idx, lon_idx)
        if key not in buckets:
            buckets[key] = {"count": 0, "sum_conf": 0.0}
        buckets[key]["count"] += 1
        buckets[key]["sum_conf"] += issue.effective_confidence

    features = []
    for (lat_idx, lon_idx), agg in buckets.items():
        lat0 = lat_idx * cell_size
        lon0 = lon_idx * cell_size
        lat1 = lat0 + cell_size
        lon1 = lon0 + cell_size
        count = agg["count"]
        avg_conf = round(agg["sum_conf"] / count, 1)
        intensity = round(min(1.0, count / 8.0), 3)
        features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[
                        [lon0, lat0],
                        [lon1, lat0],
                        [lon1, lat1],
                        [lon0, lat1],
                        [lon0, lat0],
                    ]],
                },
                "properties": {
                    "issue_count": count,
                    "avg_effective_confidence": avg_conf,
                    "intensity": intensity,
                },
            }
        )

    return {
        "type": "FeatureCollection",
        "features": features,
        "meta": {"cell_size": cell_size, "cells": len(features)},
    }


@router.get("")
def list_issues(
    lat_min: Optional[float] = None,
    lat_max: Optional[float] = None,
    lon_min: Optional[float] = None,
    lon_max: Optional[float] = None,
    category: Optional[str] = None,
    db: Session = Depends(get_db),
):
    q = db.query(Issue).filter(Issue.is_active == True)
    if lat_min is not None:
        q = q.filter(Issue.lat >= lat_min)
    if lat_max is not None:
        q = q.filter(Issue.lat <= lat_max)
    if lon_min is not None:
        q = q.filter(Issue.lon >= lon_min)
    if lon_max is not None:
        q = q.filter(Issue.lon <= lon_max)
    if category and category in VALID_CATEGORIES:
        q = q.filter(Issue.category == category)

    issues = q.order_by(Issue.reported_at.desc()).all()
    return [_issue_to_dict(i) for i in issues]


@router.get("/{issue_id}")
def get_issue(issue_id: str, db: Session = Depends(get_db)):
    issue = db.query(Issue).filter(Issue.id == issue_id).first()
    if issue is None:
        raise HTTPException(status_code=404, detail="Issue not found")
    return _issue_to_dict(issue)


@router.patch("/{issue_id}/validate")
def validate_issue(
    issue_id: str,
    body: ValidateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    issue = db.query(Issue).filter(Issue.id == issue_id, Issue.is_active == True).first()
    if issue is None:
        raise HTTPException(status_code=404, detail="Issue not found")

    # Reporter cannot validate their own issue
    if issue.reporter_id == current_user.id:
        raise HTTPException(
            status_code=403,
            detail="You cannot validate an issue you reported.",
        )

    # Prevent duplicate validations by the same user for the same issue
    existing = (
        db.query(Validation)
        .filter(Validation.issue_id == issue_id, Validation.user_id == current_user.id)
        .first()
    )
    if existing:
        raise HTTPException(
            status_code=409,
            detail="You have already validated this issue",
        )

    # Record validation
    validation = Validation(
        issue_id=issue_id,
        user_id=current_user.id,
        response=body.response,
        validated_at=datetime.now(timezone.utc),
    )
    db.add(validation)

    # Update counters — confirm does NOT increment num_reports
    if body.response == "confirm":
        issue.num_confirmations += 1
    else:
        issue.num_dismissals += 1

    issue.confidence_score = _compute_confidence(
        issue.num_reports, issue.num_confirmations, issue.num_dismissals
    )
    issue.last_validated = datetime.now(timezone.utc)

    # Deactivate if dismissed by enough users relative to reporters/confirmers
    overwhelming_dismissal = issue.num_dismissals >= 2 * max(1, issue.num_reports + issue.num_confirmations)
    if issue.confidence_score <= 20 or overwhelming_dismissal:
        issue.is_active = False

    db.commit()
    db.refresh(issue)
    return _issue_to_dict(issue)
